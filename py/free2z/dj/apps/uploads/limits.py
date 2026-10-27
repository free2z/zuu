"""
How large an upload request this creator may send — and the ONE place those
numbers live.

The ceiling is a monetization tier: an account below 1 whole 2Z gets 5MiB, and
an account with at least 1 whole 2Z gets 250MiB. The historic 5000 2Z rung
remains in the published ladder for compatibility, but it no longer raises the
per-request ceiling.
The 250MiB cap keeps every admitted body below nginx's 300,000,000-byte
buffering boundary; without this cap, an admitted larger body would stream
into the pod's single sync gunicorn worker. Before this module the table
existed twice — here in Python (as a closure inside `upload_limit`) and again
in `ts/svelte/free2z/src/lib/api/uploads.ts` — with nothing comparing them.
Two copies of a pricing table in two languages is the shape of bug a customer
finds, not CI: raise a tier server-side and the browser keeps refusing files
the server would have accepted, with no test anywhere going red.

So the table lives here, and the browser is *told* what it is
(`UploadLimitView` below, `GET /api/uploads/limits/`). That is also the reason
the view is in this module rather than in `views.py`: the endpoint exists to
publish this table, and a reader who finds the table should find the thing
that serves it without a second hop.

## Two enforcement points, one table

- `views.upload_limit` is nginx's `auth_request` subrequest. nginx sends
  `X-Original-Content-Length` and gets a bare 204/403 back. That is the
  *enforcement*, and it happens before the request body is proxied, so an
  over-limit request is refused before its body is stored or sent to Django.
- `UploadLimitView` is the *disclosure*. It changes nothing and enforces
  nothing; it answers "what would you accept from me?" so a client can say so
  up front instead of making the user wait for a rejection.

A client cannot learn the limit from the rejection: nginx's `@deny_upload`
(`k8s/free2z/nginx.conf`) answers `return 403` with no body at all, and it
replaces whatever the subrequest returned. Giving `upload_limit` a JSON body
would therefore accomplish nothing — the browser never sees it. Hence a
separate, ordinary API endpoint.

## What `max_bytes` is measured against

The REQUEST, not the file. nginx hands the subrequest `$content_length`, so
for a multipart upload the figure being compared also carries the boundaries,
the part headers, the filename and any metadata field — a few hundred bytes in
practice. A file of exactly `max_bytes` is therefore refused.

That is nginx's enforcement model and predates this module; the fix is not to
subtract an invented allowance here (there is no correct constant — the
envelope depends on the filename and the fields the client sends) but to say
so in the contract, which `UploadLimitSerializer.max_bytes` does. Clients that
want to be exact can compare the request size they are actually sending;
`ts/svelte/free2z/src/lib/components/media/uploadLimit.ts` reads it off
`xhr.upload`'s progress `total` and explains a refusal at the boundary as its
own case rather than as "your session expired".

## The tier boundaries are the product's

`min_tuzis` is compared against the balance TRUNCATED to a whole number, which
is what the original code did (`int(user.tuzis)`) and is therefore preserved
exactly: `tuzis` is a `DecimalField(decimal_places=3)`, so a balance of 0.5
truncates to 0 and sits in the free tier. Do not "improve" that, and do not
round the byte counts — they are exact binary multiples, and the UI renders
them, it does not restate them.
"""

from drf_spectacular.utils import extend_schema
from rest_framework import serializers
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

MB = 1024 * 1024

#: `(min_tuzis, max_bytes)`, ascending by `min_tuzis`. The tier that applies is
#: the LAST one whose `min_tuzis` the caller's whole-2Z balance reaches.
#: `max_bytes` is the whole request size, not the file size. Keep the 5000 rung
#: with the same cap for API compatibility; it does not grant a larger upload.
UPLOAD_SIZE_TIERS = (
    (0, 5 * MB),
    (1, 250 * MB),
    (5000, 250 * MB),
)

# nginx sends requests of 300,000,000 bytes or more through @uploads_streamed.
# Every tier must stay at or below this last buffered Content-Length.
MAX_BUFFERED_UPLOAD_REQUEST_BYTES = 299_999_999


def whole_tuzis(user) -> int:
    """
    The 2Z balance the tiers are compared against: truncated to a whole number,
    defaulting to 0 for anything without a readable balance.
    """
    try:
        return int(getattr(user, "tuzis", 0) or 0)
    except (TypeError, ValueError):
        return 0


def max_upload_bytes_for(user) -> int:
    """The largest upload request `user` may send, in bytes."""
    tuzis = whole_tuzis(user)
    limit = UPLOAD_SIZE_TIERS[0][1]
    for min_tuzis, max_bytes in UPLOAD_SIZE_TIERS:
        if tuzis >= min_tuzis:
            limit = max_bytes
    return limit


class UploadSizeTierSerializer(serializers.Serializer):
    """One rung of the upload-size ladder; repeated ceilings are allowed."""

    min_tuzis = serializers.IntegerField(
        help_text=(
            'The whole-number 2Z balance at which this tier applies. Compared '
            'against the balance truncated to an integer, so 0.999 2Z is '
            'still the 0 tier.'
        ),
    )
    max_bytes = serializers.IntegerField(
        help_text=(
            'Ceiling for this tier, in bytes, compared against the whole '
            'upload REQUEST (see `max_bytes` on the response).'
        ),
    )


class UploadLimitSerializer(serializers.Serializer):
    """What the caller may upload, and what would raise it."""

    tuzis = serializers.IntegerField(
        help_text=(
            "The caller's 2Z balance truncated to a whole number — the value "
            "the tiers below were compared against, NOT the exact balance."
        ),
    )
    max_bytes = serializers.IntegerField(
        help_text=(
            'Largest upload REQUEST the caller may make right now, in bytes. '
            'A larger one is refused by nginx with a bodiless 403 before the '
            'body is proxied. The maximum is 250 MiB for every account with '
            'at least 1 whole 2Z; 5000 2Z no longer raises this cap. This cap '
            'keeps every admitted request below nginx\'s 300,000,000-byte '
            'buffering boundary.\n\n'
            'This is the size of the whole REQUEST, not just the file: nginx '
            'compares Content-Length, which for a multipart upload also '
            'carries the boundaries, the part headers, the filename and any '
            'metadata field (a few hundred bytes in practice). A file of '
            'exactly `max_bytes` is therefore refused. Budget for the '
            'envelope rather than treating this as a file-size allowance.'
        ),
    )
    tiers = UploadSizeTierSerializer(
        many=True,
        help_text=(
            'Every rung of the ladder, ascending. The 5000 2Z rung is kept '
            'for compatibility but has the same 250 MiB request cap as the '
            '1 2Z rung; it does not represent an upload-size upgrade.'
        ),
    )


class UploadLimitView(APIView):
    """
    The caller's effective upload size limit, and the whole tier ladder.

    Read-only and side-effect free. Authenticated because uploading is: every
    upload entry point is `@login_required`, so an anonymous caller has no
    limit to report, only a sign-in to do.
    """

    permission_classes = [IsAuthenticated]

    @extend_schema(
        responses=UploadLimitSerializer,
        operation_id='uploads_limit',
        description=(
            "The maximum multipart request size the authenticated caller may "
            "upload, in bytes, plus every tier of the ladder. The request cap "
            "is 250 MiB for every balance of 1 whole 2Z or more; the historic "
            "5000 2Z rung does not raise it. If a tier admitted larger bodies, "
            "nginx would stream them and occupy the pod's only sync Django "
            "worker for the client transfer.\n\n"
            "Exists because the enforcement point cannot answer the question: "
            "nginx refuses an oversize upload with a bodiless 403 (its "
            "`@deny_upload` location replaces the subrequest's response), so "
            "without this endpoint the number is knowable only by hardcoding "
            "a copy of the server's table in every client.\n\n"
            "**Session authentication only, in practice.** This view accepts "
            "whatever the project's default authentication classes accept, "
            "including a Knox token — but the upload endpoints the limit "
            "applies to (`/uploads/handle`, `/uploads/single-public`) are "
            "plain Django `@login_required` views, which read "
            "`request.user` from the session and know nothing about DRF "
            "token authentication. A token-only client can therefore read its "
            "limit here and still not be able to upload. Porting those two "
            "handlers to DRF is what would close that, and is not this "
            "endpoint's to do."
        ),
    )
    def get(self, request, *args, **kwargs):
        payload = {
            'tuzis': whole_tuzis(request.user),
            'max_bytes': max_upload_bytes_for(request.user),
            'tiers': [
                {'min_tuzis': min_tuzis, 'max_bytes': max_bytes}
                for min_tuzis, max_bytes in UPLOAD_SIZE_TIERS
            ],
        }
        return Response(UploadLimitSerializer(payload).data)
