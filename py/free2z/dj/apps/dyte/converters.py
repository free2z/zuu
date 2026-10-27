"""URL path converters for the dyte app.

A URL must never dictate what goes in the database. The public
meeting route used to be `<str:username>/<str:type>`, and `str` matches any
non-empty run of non-slash characters, so the path segment landed straight in
`CreatorMeeting.meeting_type` via `get_or_create` — a column whose `choices`
Django only enforces inside `full_clean()`, which the API never calls.

Every novel string therefore minted a brand new row (`unique_together` is per
type) and each new row triggered a paid provider `create_meeting` call, while
anything over 20 characters blew up as a raw Postgres
`value too long for character varying(20)` 500.

Constraining the route is the cheapest place to stop that: an unknown type
simply does not resolve, so it reaches no view, no query and no provider.
`dyte.views.DyteMeeting` still re-checks the value, so the guarantee does not
depend on this file staying wired up.
"""
import re

from .models import PUBLIC_MEETING_TYPES


class PublicMeetingTypeConverter:
    """Matches exactly the public `CreatorMeeting.meeting_type` values.

    Matching is case-insensitive and `to_python` lower-cases, preserving the
    behaviour of the `meeting_type.lower()` the views have always applied —
    `/api/dyte/alice/BROADCAST` kept working, it just can no longer invent a
    new meeting type.
    """

    # `(?i:...)` is a scoped flag: it must not leak into the rest of the route
    # regex Django builds around it (the username segment stays as-is).
    regex = '(?i:%s)' % '|'.join(
        re.escape(value) for value in PUBLIC_MEETING_TYPES
    )

    def to_python(self, value):
        return value.lower()

    def to_url(self, value):
        return str(value).lower()
