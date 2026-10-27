""": a rejected API write leaves one structured, value-free log line.

The runbook for ``prod | one client keeps failing the same write`` tells the
responder to read WHY a write was refused from the logs. Before this change
the only backend trace was ``Bad Request: <path>``. These tests pin:

* the line exists, once, at WARNING, with the route pattern, status, and the
  field names + DRF error codes;
* it never carries a submitted value -- including when the response body
  DOES echo the value back (a ChoiceField message quotes the input), which is
  the case that proves the line reads codes rather than messages;
* it is scoped to writes, to 4xx, and to routes that resolved.

Negative control: remove ``RejectedWriteLogMiddleware`` from MIDDLEWARE and
every "emits" test here fails (no line), while the "never contains the value"
assertions keep passing trivially -- which is why each of those tests also
asserts the line exists first.
"""
import json
import logging

import pytest
from django.test import override_settings
from django.urls import path
from rest_framework import serializers
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework.permissions import AllowAny

from dj.util import rejected_writes
from dj.util.rejected_writes import EVENT, error_codes, rejected_write_payload

SECRET = "hunter2-Sup3rS3cret-value"
ECHOED = "attacker-chosen-echo-XYZ"
TRACE = "0af7651916cd43dd8448eb211c80319c"


class _ProbeSerializer(serializers.Serializer):
    password = serializers.CharField(min_length=64)
    kind = serializers.ChoiceField(choices=["a", "b"])
    email = serializers.EmailField(required=False)
    tags = serializers.DictField(child=serializers.IntegerField(),
                                 required=False)


class _ProbeView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request, token=None):
        _ProbeSerializer(data=request.data).is_valid(raise_exception=True)
        return Response({"ok": True})

    def put(self, request, token=None):
        # A view that builds its own 400 from serializer.errors (no raise).
        s = _ProbeSerializer(data=request.data)
        s.is_valid()
        return Response(s.errors, status=400)

    def get(self, request, token=None):
        _ProbeSerializer(data=request.data).is_valid(raise_exception=True)
        return Response({"ok": True})


urlpatterns = [
    path("api/probe-2180/<slug:token>/", _ProbeView.as_view(),
         name="probe-2180"),
]

probe_urls = override_settings(ROOT_URLCONF=__name__)


def _lines(caplog):
    out = []
    for record in caplog.records:
        if record.name != rejected_writes.logger.name:
            continue
        payload = json.loads(record.getMessage())
        assert payload["event"] == EVENT
        out.append((record, payload))
    return out


def _raw(caplog):
    return "\n".join(r.getMessage() for r in caplog.records
                     if r.name == rejected_writes.logger.name)


@pytest.mark.django_db
@probe_urls
@override_settings(PROJECT_ID="synthetic-log-project")
def test_a_field_error_is_logged_with_names_and_codes_but_not_values(
        client, caplog):
    caplog.set_level(logging.INFO)
    response = client.post(
        "/api/probe-2180/reset-tok-abc123/",
        data=json.dumps({"password": SECRET, "kind": ECHOED,
                         "email": "person-at-example"}),
        content_type="application/json",
        HTTP_X_CLOUD_TRACE_CONTEXT=f"{TRACE}/123;o=1",
    )
    assert response.status_code == 400
    # The response really does echo the submitted choice back ("... is not a
    # valid choice"), so a line built from messages WOULD leak it.
    assert ECHOED in response.content.decode()

    lines = _lines(caplog)
    assert len(lines) == 1
    record, payload = lines[0]
    assert record.levelno == logging.WARNING
    assert payload["severity"] == "WARNING"
    assert payload["method"] == "POST"
    assert payload["status"] == 400
    assert payload["route"] == "api/probe-2180/<slug:token>/"
    assert payload["view"] == "probe-2180"
    assert payload["errors"] == {
        "password": ["min_length"],
        "kind": ["invalid_choice"],
        "email": ["invalid"],
    }
    assert payload["logging.googleapis.com/trace"] == (
        f"projects/synthetic-log-project/traces/{TRACE}")
    assert "user_id" not in payload

    raw = _raw(caplog)
    for leaked in (SECRET, ECHOED, "person-at-example", "reset-tok-abc123"):
        assert leaked not in raw


@pytest.mark.django_db
@probe_urls
def test_a_view_returning_serializer_errors_is_covered_too(client, caplog):
    caplog.set_level(logging.INFO)
    response = client.put(
        "/api/probe-2180/x/",
        data=json.dumps({"password": SECRET, "kind": "a",
                         "tags": {"ok_key": "nope", "bad key!": SECRET}}),
        content_type="application/json",
    )
    assert response.status_code == 400
    [(_, payload)] = _lines(caplog)
    assert payload["errors"] == {
        "password": ["min_length"],
        # Nested keys are user data (DictField keyed by input): never logged,
        # even when identifier-shaped.
        "tags.*": ["invalid", "invalid"],
    }
    assert SECRET not in _raw(caplog)
    assert "bad key" not in _raw(caplog)
    assert "ok_key" not in _raw(caplog)


@pytest.mark.django_db
@probe_urls
def test_reads_and_unresolved_routes_are_not_logged(client, caplog):
    caplog.set_level(logging.INFO)
    assert client.generic(
        "GET", "/api/probe-2180/x/", json.dumps({"kind": "zzz"}),
        content_type="application/json").status_code == 400
    assert client.post("/api/does-not-exist/").status_code == 404
    assert client.post("/api/probe-2180/x/", data=json.dumps(
        {"password": "p" * 64, "kind": "a"}),
        content_type="application/json").status_code == 200
    assert _lines(caplog) == []


@pytest.mark.django_db
def test_real_endpoint_poisoned_payout_address(api_client, creator_factory,
                                               caplog):
    """The  shape: PATCH /api/auth/user/ answering 400."""
    caplog.set_level(logging.INFO)
    creator = creator_factory()
    api_client.force_authenticate(user=creator)
    poisoned = ("u1fugcwe8xceuyvp7t8m3rpk22e0u8m3dyzdh9hdv40zsqpyvac7lxkx5t49"
                "​nmp4p4w793")
    response = api_client.patch("/api/auth/user/", {"p2paddr": poisoned},
                                format="json")
    assert response.status_code == 400
    [(_, payload)] = _lines(caplog)
    # a re_path: the logged route is its pattern, never the raw path
    assert payload["route"] == "^api/auth/user/?$"
    assert payload["method"] == "PATCH"
    assert list(payload["errors"]) == ["p2paddr"]
    assert payload["errors"]["p2paddr"]
    assert payload["user_id"] == creator.pk
    assert "u1fugcwe8" not in _raw(caplog)


def test_error_codes_is_bounded_and_reads_no_strings():
    from rest_framework.exceptions import ErrorDetail

    data = {f"f{i}": [ErrorDetail("msg " + SECRET, code="invalid")] * 10
            for i in range(50)}
    data["plain"] = SECRET  # not an ErrorDetail -> content never read
    errors, truncated = error_codes(data)
    assert truncated
    assert len(errors) == rejected_writes.MAX_ENTRIES
    assert all(len(v) <= rejected_writes.MAX_CODES for v in errors.values())
    assert SECRET not in json.dumps(errors)

    # codex review: an identifier-shaped secret used as a nested key.
    errors, _ = error_codes({"tags": {SECRET: [ErrorDetail("x", code="invalid")]},
                             "items": [{"name": [ErrorDetail("x", code="blank")]}]})
    assert errors == {"tags.*": ["invalid"], "items.0.*": ["blank"]}

    # many=True: a root list of per-item dicts keeps its declared field names.
    errors, _ = error_codes([{"name": [ErrorDetail("x", code="blank")]}])
    assert errors == {"0.name": ["blank"]}

    errors, _ = error_codes({"detail": SECRET, "n": 5,
                             "code": ErrorDetail(SECRET, code=SECRET + " x")})
    assert errors == {"detail": ["?"], "n": ["?"], "code": ["?"]}


def test_a_logging_bug_never_changes_the_response(rf, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("bug")

    monkeypatch.setattr(rejected_writes, "rejected_write_payload", boom)
    sentinel = object()
    mw = rejected_writes.RejectedWriteLogMiddleware(lambda r: sentinel)
    assert mw(rf.post("/api/x/")) is sentinel


def test_only_4xx_writes_under_api_or_uploads(rf):
    class Match:
        route = "api/x/"
        view_name = "x"

    class Resp:
        def __init__(self, status):
            self.status_code = status

    def payload(method, path, status):
        request = getattr(rf, method.lower())(path)
        request.resolver_match = Match()
        return rejected_write_payload(request, Resp(status))

    assert payload("DELETE", "/api/x/", 403)["status"] == 403
    assert payload("POST", "/uploads/x", 413)["status"] == 413
    assert payload("POST", "/api/x/", 500) is None
    assert payload("POST", "/api/x/", 302) is None
    assert payload("POST", "/admin/x/", 400) is None
    assert payload("GET", "/api/x/", 400) is None


@pytest.mark.django_db
def test_real_endpoint_zpage_bad_vanity(api_client, creator_factory, caplog):
    """The  shape the issue names: a zPage save refused on its vanity."""
    import uuid

    from dj.apps.g12f.models import zPage

    caplog.set_level(logging.INFO)
    creator = creator_factory()
    page = zPage.objects.create(
        creator=creator, free2zaddr=str(uuid.uuid4()), vanity="ok-vanity",
        title="A page", content="Some content.")
    api_client.force_authenticate(user=creator)
    # A vanity 's validate_vanity REFUSES (non-Latin letters slugify
    # would silently drop), not one it normalizes: an accented Latin value
    # like "é" is rewritten to "e" and saved 200, so it cannot exercise the
    # refused-write log line. The ASCII marker proves no submitted text leaks.
    bad = "مرحبا zz-unique-marker"
    response = api_client.patch(f"/api/zpage/{page.free2zaddr}/",
                                {"vanity": bad}, format="json")
    assert response.status_code == 400, response.content
    [(_, payload)] = _lines(caplog)
    assert payload["errors"] == {"vanity": ["invalid"]}
    assert payload["user_id"] == creator.pk
    assert str(page.free2zaddr) not in _raw(caplog)
    assert "zz-unique-marker" not in _raw(caplog)
    assert "مرحبا" not in _raw(caplog)
    page.refresh_from_db()
    assert page.vanity == "ok-vanity"


def test_an_unresolved_lazy_user_is_never_forced(rf):
    """A write refused before authentication must not trigger a session load."""
    from django.utils.functional import SimpleLazyObject

    loads = []

    def load():
        loads.append(1)
        raise AssertionError("session looked up by the logging line")

    class Match:
        route = "api/x/"
        view_name = "x"

    class Resp:
        status_code = 429

    request = rf.post("/api/x/")
    request.resolver_match = Match()
    request.user = SimpleLazyObject(load)
    payload = rejected_write_payload(request, Resp())
    assert payload["status"] == 429
    assert "user_id" not in payload
    assert loads == []
