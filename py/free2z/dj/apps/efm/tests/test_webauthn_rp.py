"""The WebAuthn relying party comes from settings, never from the request.

Issue, finding 6. ``views.get_rp_id(request)`` used to return
``request.get_host().split(':')[0]``, and the expected origin came from
``request.build_absolute_uri('/')``. Those two values are what a passkey is
verified against immediately before ``Participant.webauthn_public_key`` and
``webauthn_credential_id`` are written, so the ``Host`` header was shaping
persistence. Production ``ALLOWED_HOSTS`` is four wildcard domains, so the RP
was not even a constant.

These tests drive the real ``py_webauthn`` verifier with a software
authenticator (``softauthn.py``) rather than mocking it, because the thing
under test *is* the arguments handed to that verifier.
"""

import json
from urllib.parse import urlsplit

import pytest
from django.core.exceptions import ImproperlyConfigured
from django.test import Client
from django.test.utils import override_settings

from dj.apps.efm.checks import check_webauthn_relying_party
from dj.apps.efm.models import Participant
from dj.apps.efm.tests.softauthn import SoftAuthenticator
from dj.apps.efm.webauthn_config import (
    get_expected_origins,
    get_rp_id,
    get_rp_name,
)

RP_ID = "free2z.cash"
RP_ORIGIN = "https://free2z.cash"
# A host that is inside production's wildcard ALLOWED_HOSTS (`.free2z.com`)
# yet is a different registrable domain -- precisely the case the old code
# would have happily minted a credential for.
OTHER_HOST = "www.free2z.com"
OTHER_ORIGIN = "https://www.free2z.com"
# What the pre- code would have computed for a request carrying
# `Host: www.free2z.com`: rp_id = that host, expected_origin =
# request.build_absolute_uri('/'), which over the (plain http) test client is
# this. The cross-domain ceremony tests below sign with exactly that pair, so
# they would have *passed verification* under the old code -- they are real
# regression tests rather than tautologies. Verified by re-running them
# against the reverted views.py.
OTHER_ORIGIN_AS_OLD_CODE_BUILT_IT = "http://www.free2z.com"

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def configured_rp():
    """Every test runs against one explicitly configured relying party.

    ALLOWED_HOSTS deliberately includes a second registrable domain, mirroring
    production's wildcard list -- the point is that a permitted Host still
    cannot move the relying party.

    ROOT_URLCONF is the test-only mount (`dj/apps/efm/tests/urls.py`): the app
    is OFFLINE and the project URLconf no longer includes it, but these tests
    are about what `views.py` hands the verifier, which is worth keeping green.
    """
    with override_settings(
        WEBAUTHN_RP_ID=RP_ID,
        WEBAUTHN_RP_NAME="Free2Z EFM",
        WEBAUTHN_EXPECTED_ORIGINS=[RP_ORIGIN],
        ALLOWED_HOSTS=[RP_ID, OTHER_HOST, "testserver", "localhost"],
        ROOT_URLCONF="dj.apps.efm.tests.urls",
    ):
        yield


def post(client, path, payload, host=RP_ID):
    return client.post(
        f"/api/efm/{path}",
        data=json.dumps(payload),
        content_type="application/json",
        HTTP_HOST=host,
    )


def start_group(client, host=RP_ID, max_participants=3):
    response = post(client, "start-group", {"max_participants": max_participants}, host)
    assert response.status_code == 200, response.content
    body = response.json()
    options = json.loads(body["registration_challenge"])
    return body, options


def register(client, authenticator, *, rp_id, origin, host=RP_ID):
    """Run a full start-group + register-webauthn ceremony.

    ``rp_id`` / ``origin`` are what the *authenticator* signs over, i.e. what
    the browser would use. ``host`` is the HTTP Host header.
    """
    body, options = start_group(client, host=host)
    credential = authenticator.register(
        rp_id=rp_id, origin=origin, challenge_b64url=options["challenge"]
    )
    response = post(
        client,
        "register-webauthn",
        {
            "group_id": body["group_id"],
            "participant_uuid": body["participant_uuid"],
            "registration_response": credential,
        },
        host,
    )
    return body, response


def authenticate(client, authenticator, body, *, rp_id, origin, host=RP_ID):
    challenge_response = post(
        client,
        "create-authentication-challenge",
        {
            "group_id": body["group_id"],
            "participant_uuid": body["participant_uuid"],
        },
        host,
    )
    assert challenge_response.status_code == 200, challenge_response.content
    options = json.loads(challenge_response.json()["authentication_challenge"])
    assertion = authenticator.authenticate(
        rp_id=rp_id, origin=origin, challenge_b64url=options["challenge"]
    )
    return options, post(
        client,
        "authenticate-webauthn",
        {
            "group_id": body["group_id"],
            "participant_uuid": body["participant_uuid"],
            "authentication_response": assertion,
        },
        host,
    )


# ---------------------------------------------------------------------------
# Happy path under the configured relying party
# ---------------------------------------------------------------------------


def test_registration_and_authentication_succeed_under_configured_rp():
    client = Client()
    authenticator = SoftAuthenticator()

    body, response = register(
        client, authenticator, rp_id=RP_ID, origin=RP_ORIGIN)
    assert response.status_code == 200, response.content

    participant = Participant.objects.get(uuid=body["participant_uuid"])
    assert participant.webauthn_credential_id
    assert participant.webauthn_public_key

    _options, auth_response = authenticate(
        client, authenticator, body, rp_id=RP_ID, origin=RP_ORIGIN)
    assert auth_response.status_code == 200, auth_response.content
    assert auth_response.json()["token"]


def test_second_configured_origin_also_works():
    """The setting is a list because one RP legitimately has several origins."""
    client = Client()
    authenticator = SoftAuthenticator()
    second = "https://app.free2z.cash"

    with override_settings(WEBAUTHN_EXPECTED_ORIGINS=[RP_ORIGIN, second]):
        _body, response = register(
            client, authenticator, rp_id=RP_ID, origin=second)
    assert response.status_code == 200, response.content


# ---------------------------------------------------------------------------
# The Host header no longer selects the relying party
# ---------------------------------------------------------------------------


def test_options_advertise_configured_rp_id_regardless_of_host():
    client = Client()

    _body, from_canonical = start_group(client, host=RP_ID)
    _body, from_other = start_group(client, host=OTHER_HOST)

    assert from_canonical["rp"]["id"] == RP_ID
    assert from_other["rp"]["id"] == RP_ID
    assert from_canonical["rp"]["name"] == "Free2Z EFM"


def test_authentication_options_advertise_configured_rp_id():
    client = Client()
    authenticator = SoftAuthenticator()
    body, response = register(
        client, authenticator, rp_id=RP_ID, origin=RP_ORIGIN)
    assert response.status_code == 200, response.content

    challenge_response = post(
        client,
        "create-authentication-challenge",
        {
            "group_id": body["group_id"],
            "participant_uuid": body["participant_uuid"],
        },
        OTHER_HOST,
    )
    options = json.loads(challenge_response.json()["authentication_challenge"])
    assert options["rpId"] == RP_ID


def test_credential_bound_to_another_rp_id_cannot_register():
    """A browser on another domain cannot persist a passkey for that domain."""
    client = Client()
    authenticator = SoftAuthenticator()

    body, response = register(
        client,
        authenticator,
        rp_id=OTHER_HOST,
        origin=OTHER_ORIGIN_AS_OLD_CODE_BUILT_IT,
        host=OTHER_HOST,
    )

    assert response.status_code == 400
    participant = Participant.objects.get(uuid=body["participant_uuid"])
    assert participant.webauthn_credential_id is None
    assert not participant.webauthn_public_key


def test_correct_rp_id_but_unlisted_origin_cannot_register():
    """Origin is checked against the setting, not against the request."""
    client = Client()
    authenticator = SoftAuthenticator()

    body, response = register(
        client,
        authenticator,
        rp_id=RP_ID,
        origin="https://evil.free2z.cash",
        host=RP_ID,
    )

    assert response.status_code == 400
    participant = Participant.objects.get(uuid=body["participant_uuid"])
    assert participant.webauthn_credential_id is None


def test_assertion_for_another_rp_id_cannot_authenticate():
    client = Client()
    authenticator = SoftAuthenticator()
    body, response = register(
        client, authenticator, rp_id=RP_ID, origin=RP_ORIGIN)
    assert response.status_code == 200, response.content

    _options, auth_response = authenticate(
        client,
        authenticator,
        body,
        rp_id=OTHER_HOST,
        origin=OTHER_ORIGIN_AS_OLD_CODE_BUILT_IT,
        host=OTHER_HOST,
    )
    assert auth_response.status_code == 400


def test_assertion_from_unlisted_origin_cannot_authenticate():
    client = Client()
    authenticator = SoftAuthenticator()
    body, response = register(
        client, authenticator, rp_id=RP_ID, origin=RP_ORIGIN)
    assert response.status_code == 200, response.content

    _options, auth_response = authenticate(
        client,
        authenticator,
        body,
        rp_id=RP_ID,
        origin="https://evil.free2z.cash",
    )
    assert auth_response.status_code == 400


# ---------------------------------------------------------------------------
# Missing configuration fails loudly -- it never falls back to the request
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("blank", ["", "   ", None])
def test_blank_rp_id_raises(blank):
    with override_settings(WEBAUTHN_RP_ID=blank):
        with pytest.raises(ImproperlyConfigured) as exc:
            get_rp_id()
    assert "WEBAUTHN_RP_ID" in str(exc.value)


@pytest.mark.parametrize("empty", [[], None, ["", "  "]])
def test_empty_expected_origins_raises(empty):
    with override_settings(WEBAUTHN_EXPECTED_ORIGINS=empty):
        with pytest.raises(ImproperlyConfigured) as exc:
            get_expected_origins()
    assert "WEBAUTHN_EXPECTED_ORIGINS" in str(exc.value)


def test_expected_origins_as_bare_string_is_refused():
    with override_settings(WEBAUTHN_EXPECTED_ORIGINS=RP_ORIGIN):
        with pytest.raises(ImproperlyConfigured):
            get_expected_origins()


def test_missing_rp_id_does_not_silently_fall_back_to_the_host():
    """The failure mode is an exception, not a request-derived relying party."""
    client = Client()
    with override_settings(WEBAUTHN_RP_ID=""):
        with pytest.raises(ImproperlyConfigured):
            post(client, "start-group", {"max_participants": 3}, OTHER_HOST)


def test_missing_expected_origins_does_not_silently_fall_back():
    client = Client()
    authenticator = SoftAuthenticator()
    body, options = start_group(client)
    credential = authenticator.register(
        rp_id=RP_ID, origin=RP_ORIGIN, challenge_b64url=options["challenge"]
    )
    with override_settings(WEBAUTHN_EXPECTED_ORIGINS=[]):
        with pytest.raises(ImproperlyConfigured):
            post(
                client,
                "register-webauthn",
                {
                    "group_id": body["group_id"],
                    "participant_uuid": body["participant_uuid"],
                    "registration_response": credential,
                },
            )
    assert Participant.objects.get(
        uuid=body["participant_uuid"]).webauthn_credential_id is None


def test_rp_name_falls_back_because_it_is_cosmetic():
    with override_settings(WEBAUTHN_RP_NAME=""):
        assert get_rp_name() == "Free2Z EFM"


# ---------------------------------------------------------------------------
# The system check catches a broken relying party before it serves traffic
# ---------------------------------------------------------------------------


def ids(messages):
    return {m.id for m in messages}


def test_check_passes_on_the_real_settings():
    assert check_webauthn_relying_party(None) == []


def test_check_flags_missing_rp_id():
    with override_settings(WEBAUTHN_RP_ID=""):
        assert "efm.E001" in ids(check_webauthn_relying_party(None))


def test_check_flags_rp_id_that_is_a_url():
    with override_settings(WEBAUTHN_RP_ID="https://free2z.cash"):
        assert "efm.E002" in ids(check_webauthn_relying_party(None))


def test_check_flags_origins_as_string():
    with override_settings(WEBAUTHN_EXPECTED_ORIGINS=RP_ORIGIN):
        assert "efm.E003" in ids(check_webauthn_relying_party(None))


def test_check_flags_empty_origins():
    with override_settings(WEBAUTHN_EXPECTED_ORIGINS=[]):
        assert "efm.E004" in ids(check_webauthn_relying_party(None))


def test_check_flags_non_absolute_origin():
    with override_settings(WEBAUTHN_EXPECTED_ORIGINS=["free2z.cash"]):
        assert "efm.E005" in ids(check_webauthn_relying_party(None))


@pytest.mark.parametrize(
    "origin",
    [
        "https://free2z.cash/tools/p2pe2e",
        "https://free2z.cash/",  # trailing slash survives urlsplit as a path
        "https://free2z.cash?x=1",
        "https://free2z.cash#frag",
        "https://user@free2z.cash",
    ],
)
def test_check_flags_origins_that_are_not_bare_origins(origin):
    """A browser reports scheme://host[:port] and py_webauthn compares exactly.

    Anything richer can never match, so it is a total EFM outage rather than a
    near miss. (The bare trailing slash is stripped before it gets here, which
    is why that case must not raise E008.)
    """
    with override_settings(WEBAUTHN_EXPECTED_ORIGINS=[origin]):
        found = ids(check_webauthn_relying_party(None))
    if origin.rstrip("/") != origin:
        assert "efm.E008" not in found
    else:
        assert "efm.E008" in found


def test_check_flags_a_non_numeric_port():
    with override_settings(WEBAUTHN_EXPECTED_ORIGINS=["https://free2z.cash:nope"]):
        assert "efm.E010" in ids(check_webauthn_relying_party(None))


@pytest.mark.parametrize(
    "origin", ["https://free2z.cash:443", "http://localhost:80"])
def test_check_flags_a_spelled_out_default_port(origin):
    """Browsers omit the default port, so ':443' matches nothing."""
    with override_settings(
        WEBAUTHN_RP_ID=urlsplit(origin).hostname,
        WEBAUTHN_EXPECTED_ORIGINS=[origin],
    ):
        assert "efm.E011" in ids(check_webauthn_relying_party(None))


def test_check_allows_a_non_default_port():
    with override_settings(
        WEBAUTHN_RP_ID="localhost",
        WEBAUTHN_EXPECTED_ORIGINS=["http://localhost:3000"],
    ):
        assert check_webauthn_relying_party(None) == []


def test_check_flags_a_misspelled_scheme():
    with override_settings(WEBAUTHN_EXPECTED_ORIGINS=["htps://free2z.cash"]):
        assert "efm.E009" in ids(check_webauthn_relying_party(None))


def test_check_flags_origin_that_can_never_match_the_rp_id():
    """The exact production trap: one deploy, several registrable domains."""
    with override_settings(WEBAUTHN_EXPECTED_ORIGINS=[RP_ORIGIN, OTHER_ORIGIN]):
        assert "efm.E006" in ids(check_webauthn_relying_party(None))


def test_check_accepts_a_subdomain_origin():
    with override_settings(WEBAUTHN_EXPECTED_ORIGINS=["https://app.free2z.cash"]):
        assert check_webauthn_relying_party(None) == []


def test_check_warns_about_plain_http_off_localhost():
    with override_settings(WEBAUTHN_EXPECTED_ORIGINS=["http://free2z.cash"]):
        assert "efm.W007" in ids(check_webauthn_relying_party(None))


def test_check_allows_plain_http_on_localhost():
    with override_settings(
        WEBAUTHN_RP_ID="localhost",
        WEBAUTHN_EXPECTED_ORIGINS=["http://localhost:3000"],
    ):
        assert check_webauthn_relying_party(None) == []
