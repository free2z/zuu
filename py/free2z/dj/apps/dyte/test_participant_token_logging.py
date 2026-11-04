"""A RealtimeKit participant auth token must never reach the logs.

``POST /v2/meetings/{id}/participants`` returns ``data.token``: a bearer
credential that lets whoever holds it join that meeting as that participant.
Root logging is INFO in prod (``dj/free2z/settings.py`` ``LOGGING``) and ships
to Cloud Logging, so an f-string of the response body wrote a live, joinable
token for every host start and every viewer join.

This matters more, not less, now that anonymous guests can join public
broadcasts: every anonymous join is a fresh participant, so the volume of
tokens written to logs scales with the audience.

The DB is real Postgres (repo convention); only the provider HTTP boundary is
mocked.
"""
import logging

import pytest

from dj.apps.dyte.client import DyteClient
from dj.apps.dyte.models import CreatorMeeting

TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.SUPER-SECRET-JOIN-TOKEN.sig"
MEETING_ID = "11111111-2222-3333-4444-555555555555"


class _Resp:
    """Minimal stand-in for the requests.Response the provider returns."""

    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload

    @property
    def text(self):
        import json
        return json.dumps(self._payload)


@pytest.fixture
def meeting(creator_factory):
    creator = creator_factory(username="hoststar")
    return CreatorMeeting.objects.create(
        creator=creator,
        meeting_id=MEETING_ID,
        meeting_type="broadcast",
        is_public=True,
        live_now=True,
    )


@pytest.mark.django_db
def test_add_participant_never_logs_the_auth_token(
    mocker, caplog, meeting, creator_factory,
):
    viewer = creator_factory(username="viewer1")
    mocker.patch(
        "dj.apps.dyte.client.requests.post",
        return_value=_Resp(200, {"success": True, "data": {
            "id": "abc", "token": TOKEN,
        }}),
    )

    with caplog.at_level(logging.DEBUG, logger="dj.apps.dyte.client"):
        resp = DyteClient("org").add_participant(viewer, MEETING_ID)

    # The caller still gets the token; only the LOG must not.
    assert resp.json()["data"]["token"] == TOKEN
    assert TOKEN not in caplog.text
    assert "SUPER-SECRET-JOIN-TOKEN" not in caplog.text
    # ...and the log is still useful for debugging a join.
    assert "add_participant ok" in caplog.text
    assert "viewer1" in caplog.text


@pytest.mark.django_db
def test_add_participant_logs_only_allowlisted_error_fields(
    mocker, caplog, meeting,
):
    """Callers retry on `error`, so the reason must survive -- but only it."""
    mocker.patch(
        "dj.apps.dyte.client.requests.post",
        return_value=_Resp(404, {
            "success": False,
            "error": {"code": 404, "message": "No meeting found"},
        }),
    )

    class _Anon:
        is_authenticated = False
        username = ""

    with caplog.at_level(logging.DEBUG, logger="dj.apps.dyte.client"):
        DyteClient("org").add_participant(_Anon(), MEETING_ID)

    assert "add_participant failed" in caplog.text
    assert "provider_code=404" in caplog.text
    assert "No meeting found" in caplog.text


@pytest.mark.django_db
def test_error_envelope_carrying_a_token_still_leaks_nothing(
    mocker, caplog, meeting, creator_factory,
):
    """The provider may create the participant AND report a partial failure.

    Nothing documents that an error envelope cannot also carry ``data.token``,
    which is exactly why the failure branch allowlists scalar fields instead
    of logging the body. Raised by the codex adversarial review of this
    change.
    """
    viewer = creator_factory(username="viewer3")
    mocker.patch(
        "dj.apps.dyte.client.requests.post",
        return_value=_Resp(207, {
            "success": False,
            "error": {"code": 207, "message": "partial"},
            "data": {"token": TOKEN},
        }),
    )

    with caplog.at_level(logging.DEBUG, logger="dj.apps.dyte.client"):
        DyteClient("org").add_participant(viewer, MEETING_ID)

    assert "add_participant failed" in caplog.text
    assert TOKEN not in caplog.text
    assert "SUPER-SECRET-JOIN-TOKEN" not in caplog.text


@pytest.mark.django_db
def test_a_nested_provider_error_field_is_not_logged_verbatim(
    mocker, caplog, meeting, creator_factory,
):
    """Only known-scalar allowlisted fields reach the log, never a container."""
    viewer = creator_factory(username="viewer4")
    mocker.patch(
        "dj.apps.dyte.client.requests.post",
        return_value=_Resp(400, {
            "success": False,
            "error": {"code": {"nested": TOKEN}, "message": {"also": TOKEN}},
        }),
    )

    with caplog.at_level(logging.DEBUG, logger="dj.apps.dyte.client"):
        DyteClient("org").add_participant(viewer, MEETING_ID)

    assert "add_participant failed" in caplog.text
    assert TOKEN not in caplog.text


@pytest.mark.django_db
def test_a_credential_embedded_in_a_provider_message_is_redacted(
    mocker, caplog, meeting, creator_factory,
):
    """The allowlist restricts field NAMES; this restricts their contents.

    Second codex adversarial-review finding: a partial-failure diagnostic can
    embed the credential in free-form prose. The message survives (operators
    need it -- DyteMeeting.post retries on `error`), the token does not.
    """
    viewer = creator_factory(username="viewer5")
    mocker.patch(
        "dj.apps.dyte.client.requests.post",
        return_value=_Resp(207, {
            "success": False,
            "error": {
                "code": 207,
                "message": f"participant created; token={TOKEN}",
            },
        }),
    )

    with caplog.at_level(logging.DEBUG, logger="dj.apps.dyte.client"):
        DyteClient("org").add_participant(viewer, MEETING_ID)

    assert TOKEN not in caplog.text
    assert "SUPER-SECRET-JOIN-TOKEN" not in caplog.text
    # The human-readable part is kept, so the log still explains the failure.
    assert "participant created" in caplog.text
    assert "[redacted]" in caplog.text


@pytest.mark.django_db
def test_redaction_keeps_a_meeting_uuid_readable(
    mocker, caplog, meeting, creator_factory,
):
    """The redaction must not eat the identifiers that make a log useful.

    A UUID's longest separator-free run is 12 hex characters, well under the
    24-character token threshold, so meeting ids survive intact.
    """
    viewer = creator_factory(username="viewer6")
    mocker.patch(
        "dj.apps.dyte.client.requests.post",
        return_value=_Resp(404, {
            "success": False,
            "error": {
                "code": 404,
                "message": f"No meeting found for id: {MEETING_ID}",
            },
        }),
    )

    with caplog.at_level(logging.DEBUG, logger="dj.apps.dyte.client"):
        DyteClient("org").add_participant(viewer, MEETING_ID)

    assert MEETING_ID in caplog.text
    assert "[redacted]" not in caplog.text


@pytest.mark.django_db
def test_a_non_numeric_provider_code_is_not_logged(
    mocker, caplog, meeting, creator_factory,
):
    """`code` is logged as a strict number, so it can carry nothing else."""
    viewer = creator_factory(username="viewer7")
    mocker.patch(
        "dj.apps.dyte.client.requests.post",
        return_value=_Resp(400, {
            "success": False,
            "error": {"code": TOKEN, "message": "bad"},
        }),
    )

    with caplog.at_level(logging.DEBUG, logger="dj.apps.dyte.client"):
        DyteClient("org").add_participant(viewer, MEETING_ID)

    assert "provider_code=?" in caplog.text
    assert TOKEN not in caplog.text


@pytest.mark.django_db
def test_a_shapeless_credential_from_this_response_is_still_redacted(
    mocker, caplog, meeting, creator_factory,
):
    """Exact-match redaction, so the token's SHAPE does not have to be guessed.

    Third codex adversarial-review finding: a shape denylist can always be
    evaded by a token that does not look like one. The credential that
    actually matters is in the response we are holding, so every string
    outside the `error` subtree is redacted from the message by exact match
    -- here a token with dots, dashes and no `eyJ` header and no 24-char run.
    """
    viewer = creator_factory(username="viewer8")
    odd_token = "tok.a-b-c.d-e-f.g-h-i.j-k-l"
    assert "eyJ" not in odd_token
    mocker.patch(
        "dj.apps.dyte.client.requests.post",
        return_value=_Resp(207, {
            "success": False,
            "error": {"code": 207, "message": f"created with {odd_token}"},
            "data": {"token": odd_token},
        }),
    )

    with caplog.at_level(logging.DEBUG, logger="dj.apps.dyte.client"):
        DyteClient("org").add_participant(viewer, MEETING_ID)

    assert odd_token not in caplog.text
    assert "created with [redacted]" in caplog.text


@pytest.mark.django_db
def test_a_message_that_is_nothing_but_the_token_is_redacted_whole(
    mocker, caplog, meeting, creator_factory,
):
    """Exact equality, not just embedding (codex finding on `secret != text`)."""
    viewer = creator_factory(username="viewer9")
    odd_token = "tok.a-b-c.d-e-f.g-h-i.j-k-l"
    mocker.patch(
        "dj.apps.dyte.client.requests.post",
        return_value=_Resp(207, {
            "success": False,
            "error": {"code": 207, "message": odd_token},
            "data": {"token": odd_token},
        }),
    )

    with caplog.at_level(logging.DEBUG, logger="dj.apps.dyte.client"):
        DyteClient("org").add_participant(viewer, MEETING_ID)

    assert odd_token not in caplog.text


@pytest.mark.django_db
def test_a_token_copied_inside_the_error_subtree_is_redacted(
    mocker, caplog, meeting, creator_factory,
):
    """Only `error.message` is excluded from the set -- not all of `error`."""
    viewer = creator_factory(username="viewer10")
    odd_token = "tok.a-b-c.d-e-f.g-h-i.j-k-l"
    mocker.patch(
        "dj.apps.dyte.client.requests.post",
        return_value=_Resp(400, {
            "success": False,
            "error": {
                "code": 400,
                "message": f"see {odd_token}",
                "details": {"token": odd_token},
            },
        }),
    )

    with caplog.at_level(logging.DEBUG, logger="dj.apps.dyte.client"):
        DyteClient("org").add_participant(viewer, MEETING_ID)

    assert odd_token not in caplog.text


@pytest.mark.django_db
def test_an_unvettably_large_body_drops_the_message(
    mocker, caplog, meeting, creator_factory,
):
    """A body too big to vet exhaustively must not leak prose from it."""
    viewer = creator_factory(username="viewer11")
    mocker.patch(
        "dj.apps.dyte.client.requests.post",
        return_value=_Resp(400, {
            "success": False,
            "error": {"code": 400, "message": "boom"},
            "noise": {f"k{i}": f"value-{i:08d}" for i in range(500)},
        }),
    )

    with caplog.at_level(logging.DEBUG, logger="dj.apps.dyte.client"):
        DyteClient("org").add_participant(viewer, MEETING_ID)

    assert "provider_message=[unvetted]" in caplog.text


@pytest.mark.django_db
@pytest.mark.parametrize("payload", [
    {},
    {"success": False},
    {"data": {}},
    {"data": {"token": None}},
    {"data": "not-an-object"},
])
def test_a_malformed_2xx_is_not_logged_as_ok(
    mocker, caplog, meeting, creator_factory, payload,
):
    """"ok" must mean a usable token came back, not merely a 2xx.

    Callers do ``resp.json()['data']['token']`` on the next line; a 200 with
    no token 500s them. Logging "ok" there made a provider incident look
    healthy in Cloud Logging.
    """
    viewer = creator_factory(username=f"viewer_{abs(hash(str(payload))) % 9999}")
    mocker.patch(
        "dj.apps.dyte.client.requests.post",
        return_value=_Resp(200, payload),
    )

    with caplog.at_level(logging.DEBUG, logger="dj.apps.dyte.client"):
        DyteClient("org").add_participant(viewer, MEETING_ID)

    assert "add_participant ok" not in caplog.text
    assert "add_participant failed" in caplog.text


@pytest.mark.django_db
def test_add_participant_survives_a_non_json_provider_response(
    mocker, caplog, meeting, creator_factory,
):
    """An HTML 502 from an intermediary must not blow up the logging branch."""
    viewer = creator_factory(username="viewer2")

    class _Html:
        status_code = 502
        text = "<html>502 Bad Gateway</html>"

        def json(self):
            raise ValueError("not json")

    mocker.patch("dj.apps.dyte.client.requests.post", return_value=_Html())

    with caplog.at_level(logging.DEBUG, logger="dj.apps.dyte.client"):
        DyteClient("org").add_participant(viewer, MEETING_ID)

    assert "add_participant failed" in caplog.text
