import base64
import binascii
import json
import uuid as uuid_module

from django.db.models import Q
from django.db.models.functions import Coalesce
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.pagination import BasePagination, PageNumberPagination
from rest_framework.response import Response
from rest_framework.utils.urls import replace_query_param


class Free2zPagination(PageNumberPagination):
    """
    Default page size of 12 keeps card grids even at 1/2/3 (and 4/6)
    columns. Honors the ?page_size= param the frontends already send —
    stock PageNumberPagination has no page_size_query_param, so those
    requests were silently served the default instead.
    """
    page_size = 12
    page_size_query_param = 'page_size'
    max_page_size = 48


class ZPageFeedCursorPagination(BasePagination):
    """Stable keyset pagination for the mobile homepage feeds.

    This paginator is opt-in (``?pagination=cursor``), so existing API
    consumers keep the page-number contract.  The opaque cursor contains the
    timestamp and integer primary key of the last row.  Subsequent pages use a
    strict keyset boundary, so inserts or deletes ahead of the reader cannot
    shift rows across an offset boundary.

    The original v1 cursor default was ``created_at``.  During the rollout to
    publication chronology, an already-issued v1 cursor with no explicit
    ordering remains a ``created_at`` continuation; otherwise a reader could
    get a 404 or silently switch feeds halfway through scrolling.  New default
    cursors use ``publication_order`` (``published_at`` with a ``created_at``
    fallback).  This paginator supplies that annotation itself so callers
    cannot accidentally turn a missing annotation into a public 500.
    """

    page_size = 20
    page_size_query_param = 'page_size'
    max_page_size = 48
    cursor_query_param = 'cursor'
    cursor_version = 1
    cursor_ordering_fields = frozenset({
        'created_at', 'updated_at', 'publication_order',
    })

    def get_page_size(self, request):
        raw = request.query_params.get(self.page_size_query_param)
        if raw is None:
            return self.page_size
        try:
            requested = int(raw)
        except (TypeError, ValueError):
            return self.page_size
        return min(max(requested, 1), self.max_page_size)

    def _ordering_field(self, request):
        home_sort = request.query_params.get('homeSort')
        ordering = request.query_params.get('ordering')

        if request.query_params.get('page') is not None:
            raise ValidationError({
                'page': (
                    'Page numbers cannot be combined with cursor pagination.'
                ),
            })

        if home_sort == 'updated':
            if ordering not in (None, '', '-updated_at', '-updated_at,-id'):
                raise ValidationError({
                    'ordering': (
                        'The updated feed cursor requires descending '
                        'updated_at ordering.'
                    ),
                })
            return 'updated_at'

        if home_sort not in (None, ''):
            raise ValidationError({
                'homeSort': (
                    'Cursor pagination supports only the chronological feed '
                    'or homeSort=updated.'
                ),
            })

        if ordering not in (
            None,
            '',
            '-published_at',
            '-published_at,-id',
            # Keep the legacy explicit ordering contract for clients that
            # intentionally request creation time rather than publication
            # chronology.
            '-created_at',
            '-created_at,-id',
        ):
            raise ValidationError({
                'ordering': (
                    'The chronological feed cursor requires descending '
                    'published_at ordering.'
                ),
            })
        if ordering in ('-created_at', '-created_at,-id'):
            return 'created_at'
        return 'publication_order'

    def _decode_cursor(self, value):
        try:
            if len(value) > 1024:
                raise ValueError
            padded = value + '=' * (-len(value) % 4)
            payload = json.loads(
                base64.b64decode(
                    padded.encode('ascii'),
                    altchars=b'-_',
                    validate=True,
                ).decode('utf-8')
            )
            if (
                not isinstance(payload, dict)
                or payload.get('v') != self.cursor_version
                or payload.get('ordering') not in self.cursor_ordering_fields
            ):
                raise ValueError
            ordering = payload['ordering']
            position = payload['position']
            if not isinstance(position, list) or len(position) != 2:
                raise ValueError
            if not isinstance(position[0], str):
                raise ValueError
            timestamp = parse_datetime(position[0])
            row_id = position[1]
            if (
                timestamp is None
                or timezone.is_naive(timestamp)
                or not isinstance(row_id, int)
                or isinstance(row_id, bool)
                or row_id < 1
            ):
                raise ValueError
            return timestamp, row_id, ordering
        except (
            binascii.Error,
            UnicodeError,
            ValueError,
            TypeError,
            KeyError,
            IndexError,
            json.JSONDecodeError,
        ):
            raise NotFound('Invalid cursor.')

    def _resolve_cursor_ordering(
            self, request, requested_ordering, cursor_ordering):
        """Keep the pre-publication-order default cursor valid for one rollout.

        A client that explicitly changes ordering must not reuse a cursor from
        another feed.  The sole compatible mismatch is the old default
        ``created_at`` cursor continued without an ``ordering`` parameter;
        its position must keep the creation-time semantics it was issued with.
        """
        if cursor_ordering == requested_ordering:
            return requested_ordering
        if (
            requested_ordering == 'publication_order'
            and cursor_ordering == 'created_at'
            and request.query_params.get('ordering') in (None, '')
        ):
            return 'created_at'
        raise NotFound('Invalid cursor.')

    @staticmethod
    def _with_publication_order(queryset):
        """Supply the timestamp expression used by publication cursors.

        The list view also uses this annotation for page-number ordering, but
        the cursor protocol owns its own ordering contract. Re-applying the
        same annotation is intentional: a new call site cannot omit it and
        leave ``filter(publication_order=...)`` or cursor encoding to raise an
        AttributeError/FieldError.
        """
        return queryset.annotate(
            publication_order=Coalesce('published_at', 'created_at'),
        )

    def _encode_cursor(self, row):
        timestamp = getattr(row, self.ordering_field).isoformat()
        payload = json.dumps(
            {
                'v': self.cursor_version,
                'ordering': self.ordering_field,
                'position': [timestamp, row.pk],
            },
            separators=(',', ':'),
        ).encode('utf-8')
        return base64.urlsafe_b64encode(payload).decode('ascii').rstrip('=')

    def paginate_queryset(self, queryset, request, view=None):
        self.request = request
        requested_ordering = self._ordering_field(request)
        page_size = self.get_page_size(request)

        cursor = request.query_params.get(self.cursor_query_param)
        if cursor:
            timestamp, row_id, cursor_ordering = self._decode_cursor(cursor)
            self.ordering_field = self._resolve_cursor_ordering(
                request, requested_ordering, cursor_ordering,
            )
        else:
            self.ordering_field = requested_ordering

        if self.ordering_field == 'publication_order':
            queryset = self._with_publication_order(queryset)

        # Preserve the established zpage-list response contract. The previous
        # page-number paginator also issued this count on every page, so cursor
        # stability does not add a new query relative to the endpoint it
        # replaces.
        self.count = queryset.count()

        if cursor:
            queryset = queryset.filter(
                Q(**{f'{self.ordering_field}__lt': timestamp})
                | Q(**{
                    self.ordering_field: timestamp,
                    'id__lt': row_id,
                })
            )

        queryset = queryset.order_by(f'-{self.ordering_field}', '-id')
        rows = list(queryset[:page_size + 1])
        self.has_next = len(rows) > page_size
        self.page = rows[:page_size]
        return self.page

    def get_next_link(self):
        if not self.has_next or not self.page:
            return None
        return replace_query_param(
            self.request.build_absolute_uri(),
            self.cursor_query_param,
            self._encode_cursor(self.page[-1]),
        )

    def get_previous_link(self):
        return None

    def get_paginated_response(self, data):
        return Response({
            'count': self.count,
            'next': self.get_next_link(),
            'previous': None,
            'results': data,
        })

    def get_paginated_response_schema(self, schema):
        return {
            'type': 'object',
            'required': ['count', 'results'],
            'properties': {
                'count': {
                    'type': 'integer',
                    'example': 123,
                },
                'next': {
                    'type': 'string',
                    'nullable': True,
                    'format': 'uri',
                },
                'previous': {
                    'type': 'string',
                    'nullable': True,
                    'format': 'uri',
                },
                'results': {
                    'type': 'array',
                    'items': schema,
                },
            },
        }


class CommentStreamCursorPagination(BasePagination):
    """Stable keyset pagination for the Converse live stream.

    Modeled on:class:`ZPageFeedCursorPagination` -- the same opt-in
    ``?pagination=cursor`` contract and the same v1 cursor envelope -- but
    simpler, because the ordering is fixed and the cursor needs no ordering
    negotiation.

    Why it exists: page-number pagination counts ROWS. A post that arrives
    between two fetches shifts every later row down one slot, so the reader
    silently skips a post and sees another twice. On a live microblog that is
    the common case, not an edge case, and ``/converse`` de-dupes by uuid, so
    the only remaining symptom is the omission -- the one nobody can see. A
    keyset boundary is anchored to the last row SEEN, so inserts ahead of the
    reader cannot move it.

    The tiebreak column matters: ``created_at`` alone is not unique under bulk
    import, and two rows sharing a timestamp would make the boundary
    ambiguous (rows skipped or repeated exactly as with offsets). ``Comment``'s
    primary key is a ``UUIDField`` named ``uuid``, so ``(-created_at, -uuid)``
    is a total order without an integer ``id`` the model does not have.

    The ``-tuzis`` ("Hot") ordering is score-driven and mutable: every vote
    reshuffles it, so a cursor anchored to it would skip or repeat posts. Hot
    stays on page-number pagination, and asking to combine the two is a loud
    400 rather than a silent fallback to creation order under a UI that says
    Hot.

    INDEX NOTE, deliberately unresolved here. ``comments_comment`` carries no
    index on ``created_at``: only the ``uuid`` primary key and the three FK
    indexes (``author_id``, ``content_type_id``, ``parent_id``). So both the
    ordering and the ``created_at <:ts`` boundary are served by a sort over
    the filtered rows, exactly as the page-number mode beside it already is --
    correctness is unaffected and this is not a regression, but it is also not
    the O(log n) seek keyset pagination is capable of. The index that would
    earn it is a migration:

        Index(fields=['-created_at', '-uuid'], name='comment_stream_ck')

    plus, for the microblog-only stream, a partial index on the same columns
    ``WHERE parent_id IS NULL AND content_type_id IS NULL``, and
    ``(author_id, -created_at, -uuid)`` for the profile Posts tab. Adding one
    is out of this slice's scope ( ships no migration); it is reported as
    ``migration_needed`` so exactly one agent owns it when it lands.
    """

    # Same numbers as Free2zPagination so the two modes feel identical to a
    # client switching between them.
    page_size = 12
    page_size_query_param = 'page_size'
    max_page_size = 48
    cursor_query_param = 'cursor'
    cursor_version = 1
    # The stream's one true ordering. Newest first; the UUID breaks ties so a
    # shared timestamp cannot shuffle rows across a page boundary.
    ordering = ('-created_at', '-uuid')
    # What a client may say in ``ordering=`` and still be served this feed.
    # An allowlist, not a blocklist: ``ordering=created_at`` (ascending) or
    # anything else would otherwise be silently discarded when
    # paginate_queryset force-applies the fixed ordering, and the client would
    # read a feed that is not the one it asked for.
    accepted_orderings = frozenset({'', '-created_at', '-created_at,-uuid'})

    def get_page_size(self, request):
        raw = request.query_params.get(self.page_size_query_param)
        if raw is None:
            return self.page_size
        try:
            requested = int(raw)
        except (TypeError, ValueError):
            return self.page_size
        return min(max(requested, 1), self.max_page_size)

    def _reject_incompatible_params(self, request):
        """Fail loudly on query params this mode cannot honour.

        A silent ignore is the worst outcome for each of these: a client
        sending ``page=`` believes it is reading numbered pages while we serve
        keyset pages, and a client asking for Hot believes it is seeing the
        score-sorted feed while we serve creation order. Both look like a
        working feed and neither is the feed that was asked for.
        """
        if request.query_params.get('page') is not None:
            raise ValidationError({
                'page': (
                    'Page numbers cannot be combined with cursor pagination.'
                ),
            })
        requested = request.query_params.get('ordering') or ''
        if requested.replace(' ', '') not in self.accepted_orderings:
            raise ValidationError({
                'ordering': (
                    'Cursor pagination serves the stream newest-first only '
                    '(-created_at). The Hot sort (-tuzis) is score-driven '
                    'and mutable; use page-number pagination for it.'
                ),
            })

    def _decode_cursor(self, value):
        """Parse the opaque token defensively; junk is a 404, never a 500.

        The envelope matches ZPageFeedCursorPagination's v1 shape --
        ``{"v":1,"ordering":"-created_at","position":[iso_ts, uuid_str]}``,
        urlsafe base64 -- so tooling built for one cursor can read the other.
        Everything is validated before it reaches the ORM: a forged or
        truncated token must fall off the end as ``Invalid cursor.``
        """
        try:
            if len(value) > 1024:
                raise ValueError
            padded = value + '=' * (-len(value) % 4)
            payload = json.loads(
                base64.b64decode(
                    padded.encode('ascii'),
                    altchars=b'-_',
                    validate=True,
                ).decode('utf-8')
            )
            if (
                not isinstance(payload, dict)
                or payload.get('v') != self.cursor_version
                or payload.get('ordering') != self.ordering[0]
            ):
                raise ValueError
            position = payload['position']
            if not isinstance(position, list) or len(position) != 2:
                raise ValueError
            # Reject non-strings before their parsers run: UUID() also
            # accepts ints, which would silently decode an int position into
            # some unrelated well-formed UUID.
            if not isinstance(position[0], str):
                raise ValueError
            if not isinstance(position[1], str):
                raise ValueError
            timestamp = parse_datetime(position[0])
            row_uuid = uuid_module.UUID(position[1])
            if timestamp is None or timezone.is_naive(timestamp):
                raise ValueError
            return timestamp, row_uuid
        except (
            binascii.Error,
            UnicodeError,
            ValueError,
            TypeError,
            KeyError,
            IndexError,
            json.JSONDecodeError,
        ):
            raise NotFound('Invalid cursor.')

    def _encode_cursor(self, row):
        payload = json.dumps(
            {
                'v': self.cursor_version,
                'ordering': self.ordering[0],
                'position': [row.created_at.isoformat(), str(row.uuid)],
            },
            separators=(',', ':'),
        ).encode('utf-8')
        return base64.urlsafe_b64encode(payload).decode('ascii').rstrip('=')

    def paginate_queryset(self, queryset, request, view=None):
        self.request = request
        self._reject_incompatible_params(request)
        page_size = self.get_page_size(request)

        # Preserve the established response contract: Free2zPagination also
        # issues a full count on every page, so cursor stability does not add
        # a query relative to the mode it sits beside.
        self.count = queryset.count()

        cursor = request.query_params.get(self.cursor_query_param)
        if cursor:
            timestamp, row_uuid = self._decode_cursor(cursor)
            queryset = queryset.filter(
                Q(created_at__lt=timestamp)
                | Q(created_at=timestamp, uuid__lt=row_uuid)
            )

        queryset = queryset.order_by(*self.ordering)
        rows = list(queryset[:page_size + 1])
        self.has_next = len(rows) > page_size
        self.page = rows[:page_size]
        return self.page

    def get_next_link(self):
        if not self.has_next or not self.page:
            return None
        return replace_query_param(
            self.request.build_absolute_uri(),
            self.cursor_query_param,
            self._encode_cursor(self.page[-1]),
        )

    def get_previous_link(self):
        # Keyset pagination walks forward only; `previous` exists in the
        # envelope solely so the response shape stays identical to
        # Free2zPagination's.
        return None

    def get_paginated_response(self, data):
        return Response({
            'count': self.count,
            'next': self.get_next_link(),
            'previous': None,
            'results': data,
        })

    def get_paginated_response_schema(self, schema):
        # Deliberately identical to the page-number schema so clients see ONE
        # list contract regardless of which pagination mode served the page.
        return {
            'type': 'object',
            'required': ['count', 'results'],
            'properties': {
                'count': {
                    'type': 'integer',
                    'example': 123,
                },
                'next': {
                    'type': 'string',
                    'nullable': True,
                    'format': 'uri',
                },
                'previous': {
                    'type': 'string',
                    'nullable': True,
                    'format': 'uri',
                },
                'results': {
                    'type': 'array',
                    'items': schema,
                },
            },
        }
