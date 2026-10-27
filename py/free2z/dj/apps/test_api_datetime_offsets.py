"""Every datetime the API emits carries an explicit UTC offset.

A just-charged platform fee showed as "in 4 hours" on the notifications page
to a viewer in EDT (UTC-4). The column was right -- ``USE_TZ`` is on and
``Event.created_at`` is ``auto_now_add`` -- but ``EventSerializer`` rendered it
with ``format="%Y-%m-%d %H:%M:%S"``: the UTC wall-clock time with the offset
thrown away. ``new Date("2026-09-28 18:00:00")`` is *local* time in every
browser, so the fee landed four hours in the viewer's future.

Guarded here from two ends:

* statically, every DRF ``DateTimeField`` declared on any serializer the URL
  conf can reach must render with an offset (DRF's default ISO 8601 gives
  ``...Z``; an explicit strftime format must contain ``%z`` or a literal
  ``Z``), and the project-wide DRF format must be ISO 8601;
* end to end, the events API and the pub/sub payload (``Event.to_dict``) both
  emit a ``created_at`` that parses as an aware datetime equal to the row.

Negative control: restore ``format="%Y-%m-%d %H:%M:%S"`` on
``EventSerializer.created_at`` -- the static walk names that field and both
end-to-end tests fail.
"""
import datetime

import pytest
from django.conf import settings
from django.urls import get_resolver
from django.utils import timezone
from rest_framework import ISO_8601, serializers
from rest_framework.fields import empty
from rest_framework.settings import api_settings

from dj.apps.events.models import Event


def _all_subclasses(cls):
    seen = set()
    stack = [cls]
    while stack:
        current = stack.pop()
        for sub in current.__subclasses__():
            if sub not in seen:
                seen.add(sub)
                stack.append(sub)
    return seen


def _format_has_offset(fmt) -> bool:
    if fmt is empty:
        fmt = api_settings.DATETIME_FORMAT
    if fmt is None:
        # DRF hands the datetime object to the JSON encoder, which calls
        # isoformat() on the (aware, USE_TZ) value -- offset included.
        return True
    if isinstance(fmt, str) and fmt.lower() == ISO_8601:
        return True
    # A literal trailing "Z" is only honest because TIME_ZONE is UTC and
    # nothing activates another zone (asserted below), so DRF's
    # enforce_timezone() has already converted the value to UTC.
    return isinstance(fmt, str) and ("%z" in fmt or fmt.endswith("Z"))


def test_timezone_settings_are_utc_and_aware():
    assert settings.USE_TZ is True
    assert settings.TIME_ZONE == "UTC"
    assert api_settings.DATETIME_FORMAT == ISO_8601


def test_every_declared_serializer_datetime_renders_an_offset():
    # Importing the URL conf imports every view, and with them every
    # serializer the API can actually respond with.
    assert get_resolver().url_patterns

    serializer_classes = _all_subclasses(serializers.BaseSerializer)
    checked = 0
    offenders = []
    for cls in serializer_classes:
        declared = getattr(cls, "_declared_fields", None) or {}
        for name, field in declared.items():
            if not isinstance(field, serializers.DateTimeField):
                continue
            checked += 1
            if not _format_has_offset(getattr(field, "format", empty)):
                offenders.append(
                    f"{cls.__module__}.{cls.__qualname__}.{name} "
                    f"format={getattr(field, "format", empty)!r}")

    # A walk that found nothing proves nothing: EventSerializer declares
    # created_at explicitly, so the walk must at least have seen it.
    assert checked > 0
    assert any(
        cls.__name__ == "EventSerializer" for cls in serializer_classes)
    assert offenders == [], (
        "Serializer datetimes rendered WITHOUT a UTC offset. A browser "
        "parses an offset-less string as the viewer's local time (#2285); "
        "drop the custom format or include %z:\n  " + "\n  ".join(offenders))


def _assert_aware_and_equal(rendered: str, expected: datetime.datetime):
    parsed = datetime.datetime.fromisoformat(rendered)
    assert parsed.tzinfo is not None, rendered
    assert parsed.utcoffset() is not None, rendered
    assert parsed == expected, (rendered, expected)


@pytest.mark.django_db
def test_events_api_created_at_carries_an_offset(api_client, creator_factory):
    user = creator_factory()
    before = timezone.now()
    event = Event.objects.create(
        type="PLATFORM_FEE", amount=1, receiving_user=user)
    api_client.force_authenticate(user=user)

    response = api_client.get("/api/events/")
    assert response.status_code == 200
    data = response.json()
    items = data["results"] if isinstance(data, dict) else data
    [item] = [i for i in items if i["id"] == str(event.pk)]

    rendered = item["created_at"]
    _assert_aware_and_equal(rendered, event.created_at)
    # And it is "now", not hours in the future or past.
    parsed = datetime.datetime.fromisoformat(rendered)
    assert abs((parsed - before).total_seconds()) < 60


@pytest.mark.django_db
def test_event_pubsub_payload_created_at_carries_an_offset(creator_factory):
    """``to_dict`` is what the post_save signal publishes to the live
    notification socket -- the other way a fee reaches the page."""
    user = creator_factory()
    event = Event.objects.create(
        type="PLATFORM_FEE", amount=1, receiving_user=user)
    _assert_aware_and_equal(event.to_dict()["created_at"], event.created_at)
