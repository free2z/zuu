"""Opt-in receipt traversal; creation order is never a commit watermark.

Each recovery must start a new scan and visit every receipt. A transaction
may create an event below an earlier scan's boundary and commit afterwards.
Revisiting all receipt IDs on the next scan makes that event observable;
clients retain account-scoped acknowledged IDs separately from a bounded
websocket deduplication cache. Interrupted scans cannot acknowledge completion.
"""
from datetime import datetime, timezone
from uuid import UUID, uuid4
from urllib.parse import urlencode

from django.core import signing
from django.db.models import Q
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from dj.free2z.pagination import Free2zPagination

RECEIPT_TYPES = ('BOUGHT_TUZI', 'ZEC_PENDING')
PAGE_SIZE = 48
CURSOR_MAX_AGE = 7200
BOUNDARY_SALT = 'events.receipt-recovery.boundary.v1'
CURSOR_SALT = 'events.receipt-recovery.cursor.v1'


def _point(event):
    return [event.created_at.astimezone(timezone.utc).isoformat(
        timespec='microseconds'), str(event.pk)]


def _parse_point(point):
    if not isinstance(point, list) or len(point) != 2:
        raise ValueError('Invalid keyset point')
    stamp, identity = point
    parsed = datetime.fromisoformat(stamp)
    if parsed.tzinfo is None or parsed.isoformat(timespec='microseconds') != stamp:
        raise ValueError('Noncanonical timestamp')
    parsed_id = UUID(identity)
    if str(parsed_id) != identity or parsed.utcoffset().total_seconds() != 0:
        raise ValueError('Noncanonical keyset point')
    return parsed, parsed_id


def _below(point, inclusive=False):
    stamp, identity = _parse_point(point)
    tie = {'id__lte' if inclusive else 'id__lt': identity}
    return Q(created_at__lt=stamp) | (Q(created_at=stamp) & Q(**tie))


class EventPagination(Free2zPagination):
    """The normal feed retains page-number pagination and updated_at order."""

    def paginate_queryset(self, queryset, request, view=None):
        mode = request.query_params.get('recovery')
        self.recovering_receipts = mode == 'payments'
        if not self.recovering_receipts:
            if mode is not None or 'recovery_cursor' in request.query_params:
                raise ValidationError({'recovery': 'Invalid receipt recovery mode.'})
            return super().paginate_queryset(queryset, request, view)

        receipts = queryset.filter(type__in=RECEIPT_TYPES)
        cursor = request.query_params.get('recovery_cursor')
        if cursor is not None:
            try:
                if len(cursor) > 4096:
                    raise ValueError('Cursor too long')
                payload = signing.loads(cursor, salt=CURSOR_SALT,
                                        max_age=CURSOR_MAX_AGE)
                boundary = payload['boundary']
                state = signing.loads(boundary, salt=BOUNDARY_SALT,
                                      max_age=CURSOR_MAX_AGE)
                if state['user'] != str(request.user.pk):
                    raise ValueError('Wrong recipient')
                UUID(state['scan'])
                count_hint = state['count']
                if type(count_hint) is not int or not 0 <= count_hint <= 2**63 - 1:
                    raise ValueError('Invalid count hint')
                upper = _parse_point(state['upper'])
                before = _parse_point(payload['before'])
                if before > upper:
                    raise ValueError('Cursor above scan boundary')
                receipts = receipts.filter(_below(state['upper'], inclusive=True))
                remaining = receipts.filter(_below(payload['before']))
            except (signing.BadSignature, ValueError, TypeError, KeyError,
                    AttributeError, OverflowError):
                raise ValidationError({'recovery_cursor': 'Invalid or expired receipt cursor.'})
        else:
            remaining = receipts
            boundary = None

        rows = list(remaining.order_by('-created_at', '-id')[:PAGE_SIZE + 1])
        if boundary is None:
            count_hint = receipts.count()
            boundary = signing.dumps({
                'user': str(request.user.pk), 'scan': str(uuid4()),
                'upper': _point(rows[0]) if rows else None,
                'count': count_hint,
            }, salt=BOUNDARY_SALT)
        self.boundary = boundary
        # The initial hint can become stale; next=null alone proves completion.
        # Carry it in the authenticated boundary instead of recounting each page.
        self.receipt_count = count_hint
        self.next_url = None
        if len(rows) > PAGE_SIZE:
            next_cursor = signing.dumps({
                'boundary': boundary, 'before': _point(rows[PAGE_SIZE - 1]),
            }, salt=CURSOR_SALT)
            self.next_url = request.build_absolute_uri(request.path) + '?' + urlencode({
                'recovery': 'payments', 'recovery_cursor': next_cursor,
            })
        return rows[:PAGE_SIZE]

    def get_paginated_response(self, data):
        if not self.recovering_receipts:
            return super().get_paginated_response(data)
        return Response({
            'count': self.receipt_count, 'next': self.next_url,
            'previous': None, 'results': data,
            'recovery_boundary': self.boundary,
        })

    def get_paginated_response_schema(self, schema):
        result = super().get_paginated_response_schema(schema)
        result['properties']['recovery_boundary'] = {
            'type': 'string', 'readOnly': True,
            'description': 'Opaque current-scan identity for payment recovery only; '
                           'never a cross-scan commit watermark. Each recovery must '
                           'visit all receipts. Only next=null means completion.',
        }
        return result
