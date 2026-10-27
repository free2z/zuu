"""The WebAuthn signature counter is persisted, and used the way the spec says.

Issue, part 2. ``authenticate_webauthn`` read ``participant.sign_count``
and handed it to the verifier but never wrote the verified counter back, so
the stored value was 0 forever and the clone-detection check was structurally
incapable of firing. These tests cover the three behaviours that matter:

1. the counter is stored and advances (otherwise nothing else here is real);
2. an assertion whose counter fails to advance is rejected and logged;
3. an authenticator that reports 0 forever still authenticates, every time.

(3) is the one that protects real users. Touch ID, Windows Hello and most
other platform authenticators do not implement the counter at all -- they
report 0 on every assertion for the life of the credential. WebAuthn L2 7.2
step 21 says that when both the stored and the presented counter are 0 the
authenticator simply does not support the counter, which is emphatically not a
clone. A naive ``presented <= stored`` would lock those users out permanently,
which is a far worse bug than the one being fixed.

Like ``test_webauthn_rp.py``, these drive the real ``py_webauthn`` verifier
through a software authenticator rather than mocking it: the behaviour under
test is a property of the verified assertion, and a mock would prove nothing.
"""

import json
import logging
import threading

import pytest
from django import db
from django.test import Client

from dj.apps.efm.models import Participant, WebAuthnChallenge
from dj.apps.efm.tests.softauthn import SoftAuthenticator
from dj.apps.efm.tests.test_webauthn_rp import (
    RP_ID,
    RP_ORIGIN,
    authenticate,
    configured_rp,  # noqa: F401 -- imported so the autouse fixture applies here
    post,
    register,
)
from dj.apps.efm.views import SIGN_COUNT_REGRESSION_EVENT

pytestmark = pytest.mark.django_db

VIEWS_LOGGER = "dj.apps.efm.views"


def stored_sign_count(body) -> int:
    """Read the counter back out of Postgres, not out of a Python object."""
    return Participant.objects.get(uuid=body["participant_uuid"]).sign_count


def authenticate_at(client, authenticator, body, counter: int):
    """Run one assertion with the authenticator's counter set to ``counter``.

    Real authenticators increment their own counter; the software one lets a
    test place it anywhere, which is how a replay (counter goes backwards) and
    a counter-less device (counter never moves) are both expressible.
    """
    authenticator.sign_count = counter
    return authenticate(
        client, authenticator, body, rp_id=RP_ID, origin=RP_ORIGIN)[1]


def build_assertion(client, authenticator, body, counter: int) -> dict:
    """Get a fresh challenge and sign it, without submitting it.

    Lets a test submit the *same bytes* more than once, which is what a replay
    actually is -- ``authenticate_at`` signs a new challenge every call and so
    can never express one.
    """
    authenticator.sign_count = counter
    challenge_response = post(
        client,
        "create-authentication-challenge",
        {
            "group_id": body["group_id"],
            "participant_uuid": body["participant_uuid"],
        },
    )
    assert challenge_response.status_code == 200, challenge_response.content
    options = json.loads(challenge_response.json()["authentication_challenge"])
    return authenticator.authenticate(
        rp_id=RP_ID, origin=RP_ORIGIN, challenge_b64url=options["challenge"])


def submit_assertion(client, body, assertion):
    return post(
        client,
        "authenticate-webauthn",
        {
            "group_id": body["group_id"],
            "participant_uuid": body["participant_uuid"],
            "authentication_response": assertion,
        },
    )


def regression_events(caplog):
    """The structured clone-signal records, parsed the way the log-based
    metric parses them (``jsonPayload``, not a substring match)."""
    events = []
    for record in caplog.records:
        if record.name != VIEWS_LOGGER:
            continue
        try:
            payload = json.loads(record.getMessage())
        except ValueError:
            continue
        if payload.get("event") == SIGN_COUNT_REGRESSION_EVENT:
            events.append((record, payload))
    return events


# ---------------------------------------------------------------------------
# 1. The counter is persisted and advances
# ---------------------------------------------------------------------------


def test_sign_count_is_persisted_and_advances():
    client = Client()
    authenticator = SoftAuthenticator()

    body, response = register(
        client, authenticator, rp_id=RP_ID, origin=RP_ORIGIN)
    assert response.status_code == 200, response.content

    for counter in (1, 2, 17):
        auth_response = authenticate_at(client, authenticator, body, counter)
        assert auth_response.status_code == 200, auth_response.content
        assert auth_response.json()["token"]
        assert stored_sign_count(body) == counter


def test_registration_seeds_the_counter_from_the_attestation():
    """WebAuthn L2 7.1 step 22: the credential record starts at the counter the
    authenticator reported during registration, not at a hardcoded 0.

    A security key that has already been used for other sites arrives with a
    non-zero counter, and seeding is what makes the *first* assertion compare
    against the right baseline.
    """
    client = Client()
    authenticator = SoftAuthenticator()
    authenticator.sign_count = 41

    body, response = register(
        client, authenticator, rp_id=RP_ID, origin=RP_ORIGIN)
    assert response.status_code == 200, response.content
    assert stored_sign_count(body) == 41

    assert authenticate_at(
        client, authenticator, body, 42).status_code == 200
    assert stored_sign_count(body) == 42


# ---------------------------------------------------------------------------
# 2. A counter that fails to advance is rejected
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("replayed", [7, 3, 1])
def test_counter_that_does_not_advance_is_rejected(replayed, caplog):
    """Equal is rejected too -- an exact replay of a captured assertion
    presents the *same* counter, so ``<=`` rather than ``<`` is the check.
    """
    client = Client()
    authenticator = SoftAuthenticator()

    body, response = register(
        client, authenticator, rp_id=RP_ID, origin=RP_ORIGIN)
    assert response.status_code == 200, response.content

    assert authenticate_at(client, authenticator, body, 7).status_code == 200
    assert stored_sign_count(body) == 7

    with caplog.at_level(logging.WARNING, logger=VIEWS_LOGGER):
        auth_response = authenticate_at(client, authenticator, body, replayed)

    assert auth_response.status_code == 400
    assert auth_response.json()["error"] == "Authentication failed"
    # The stored counter does not move backwards on a rejected assertion.
    assert stored_sign_count(body) == 7

    # An operator has to be able to alert on this. The event is emitted as
    # one-line JSON so Cloud Logging turns it into `jsonPayload`, which is
    # what monitoring/log-metrics/webauthn-sign-count-regression.json filters
    # on -- assert the fields that filter and the triage need.
    regressions = regression_events(caplog)
    assert len(regressions) == 1, caplog.text
    record, payload = regressions[0]
    assert record.levelno == logging.WARNING
    assert payload["severity"] == "WARNING"
    assert payload["outcome"] == "rejected"
    assert payload["participant_uuid"] == body["participant_uuid"]
    assert payload["group_uuid"] == body["group_id"]
    assert payload["stored_sign_count"] == 7
    assert payload["presented_sign_count"] == replayed
    # No credential material in a log line.
    assert "webauthn_public_key" not in payload


def test_rejected_assertion_does_not_hand_out_a_token():
    client = Client()
    authenticator = SoftAuthenticator()
    body, response = register(
        client, authenticator, rp_id=RP_ID, origin=RP_ORIGIN)
    assert response.status_code == 200, response.content
    assert authenticate_at(client, authenticator, body, 5).status_code == 200

    auth_response = authenticate_at(client, authenticator, body, 5)
    assert auth_response.status_code == 400
    assert "token" not in auth_response.json()


def test_a_genuine_authenticator_can_recover_after_a_rejection():
    """Rejecting is fail-closed, not a permanent lockout: the participant's
    credential is untouched and the next advancing assertion works.
    """
    client = Client()
    authenticator = SoftAuthenticator()
    body, response = register(
        client, authenticator, rp_id=RP_ID, origin=RP_ORIGIN)
    assert response.status_code == 200, response.content

    assert authenticate_at(client, authenticator, body, 9).status_code == 200
    assert authenticate_at(client, authenticator, body, 9).status_code == 400
    assert authenticate_at(client, authenticator, body, 10).status_code == 200
    assert stored_sign_count(body) == 10


def test_rejection_keeps_the_credential_but_burns_the_challenge(caplog):
    """A rejected assertion must not stay resubmittable.

    Whoever holds a stale-but-validly-signed assertion could otherwise replay
    that exact POST forever: each attempt costs a signature verification, a
    row lock, and -- worse -- one more page-worthy warning. The challenge is
    consumed on rejection, so the second submission of the same bytes never
    reaches the counter check at all. The credential itself survives: a
    counter regression is not a reason to de-register a participant, and doing
    so would make a spurious detection unrecoverable.
    """
    client = Client()
    authenticator = SoftAuthenticator()
    body, response = register(
        client, authenticator, rp_id=RP_ID, origin=RP_ORIGIN)
    assert response.status_code == 200, response.content
    assert authenticate_at(client, authenticator, body, 4).status_code == 200

    stale = build_assertion(client, authenticator, body, 4)
    with caplog.at_level(logging.WARNING, logger=VIEWS_LOGGER):
        assert submit_assertion(client, body, stale).status_code == 400
        # Same bytes again: no challenge left, so a 404 and -- the point --
        # no second alert.
        assert submit_assertion(client, body, stale).status_code == 404
        assert submit_assertion(client, body, stale).status_code == 404
    assert len(regression_events(caplog)) == 1, caplog.text

    participant = Participant.objects.get(uuid=body["participant_uuid"])
    assert participant.webauthn_credential_id
    assert participant.webauthn_public_key
    assert not WebAuthnChallenge.objects.filter(
        participant=participant, challenge_type="authentication"
    ).exists()


def test_a_replayed_assertion_from_a_counter_less_device_is_still_one_use():
    """The 0/0 exemption gives up counter-based replay detection, so the
    one-time challenge has to carry it alone -- which is why the challenge is
    read and deleted inside the same locked transaction as the verification.
    """
    client = Client()
    authenticator = SoftAuthenticator()
    body, response = register(
        client, authenticator, rp_id=RP_ID, origin=RP_ORIGIN)
    assert response.status_code == 200, response.content

    assertion = build_assertion(client, authenticator, body, 0)
    assert submit_assertion(client, body, assertion).status_code == 200
    assert submit_assertion(client, body, assertion).status_code == 404


@pytest.mark.django_db(transaction=True)
def test_concurrent_submissions_of_one_assertion_mint_one_token():
    """Two copies of the same assertion in flight at once.

    This is the interleaving the participant row lock exists for. It matters
    most for a counter-less authenticator, where the counter check is exempt
    by design and cannot break the tie -- exactly one request may win.
    """
    client = Client()
    authenticator = SoftAuthenticator()
    body, response = register(
        client, authenticator, rp_id=RP_ID, origin=RP_ORIGIN)
    assert response.status_code == 200, response.content
    assertion = build_assertion(client, authenticator, body, 0)

    results = []
    barrier = threading.Barrier(2)

    def submit():
        try:
            barrier.wait(timeout=10)
            results.append(submit_assertion(Client(), body, assertion).status_code)
        finally:
            # Each thread opened its own connection; leaving it open wedges
            # the test database teardown.
            db.connections.close_all()

    threads = [threading.Thread(target=submit) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert sorted(results) == [200, 404], results


@pytest.mark.django_db(transaction=True)
def test_concurrent_challenge_issuance_leaves_exactly_one_challenge():
    """`create-authentication-challenge` deletes then creates.

    Unserialised, two concurrent calls can both delete before either inserts
    and leave two rows -- after which every authentication fetches the
    challenge with `get`, raises MultipleObjectsReturned, and 500s until some
    later single call happens to repair the row set. The same participant lock
    that serialises assertions serialises issuance.
    """
    client = Client()
    authenticator = SoftAuthenticator()
    body, response = register(
        client, authenticator, rp_id=RP_ID, origin=RP_ORIGIN)
    assert response.status_code == 200, response.content

    barrier = threading.Barrier(2)
    statuses = []

    def issue():
        try:
            barrier.wait(timeout=10)
            statuses.append(post(
                Client(),
                "create-authentication-challenge",
                {
                    "group_id": body["group_id"],
                    "participant_uuid": body["participant_uuid"],
                },
            ).status_code)
        finally:
            db.connections.close_all()

    threads = [threading.Thread(target=issue) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert statuses == [200, 200], statuses
    assert WebAuthnChallenge.objects.filter(
        participant__uuid=body["participant_uuid"],
        challenge_type="authentication",
    ).count() == 1
    # And the participant is still usable, which is the point.
    assert authenticate_at(client, authenticator, body, 1).status_code == 200


# ---------------------------------------------------------------------------
# 3. The all-zero case -- the test that protects real users
# ---------------------------------------------------------------------------


def test_authenticator_that_always_reports_zero_authenticates_every_time():
    """Touch ID, Windows Hello, and most platform authenticators never
    implement the counter: it is 0 at registration and 0 on every assertion,
    forever. WebAuthn L2 7.2 step 21 says that is "not supported", not
    "cloned". If this test ever goes red, every passkey user is locked out.
    """
    client = Client()
    authenticator = SoftAuthenticator()
    assert authenticator.sign_count == 0

    body, response = register(
        client, authenticator, rp_id=RP_ID, origin=RP_ORIGIN)
    assert response.status_code == 200, response.content
    assert stored_sign_count(body) == 0

    for _ in range(5):
        auth_response = authenticate_at(client, authenticator, body, 0)
        assert auth_response.status_code == 200, auth_response.content
        assert auth_response.json()["token"]
        assert stored_sign_count(body) == 0


def test_zero_from_a_counter_less_device_logs_no_clone_warning(caplog):
    """The common case must also be quiet -- an alert that fires on every
    normal login is an alert nobody reads.
    """
    client = Client()
    authenticator = SoftAuthenticator()
    body, response = register(
        client, authenticator, rp_id=RP_ID, origin=RP_ORIGIN)
    assert response.status_code == 200, response.content

    with caplog.at_level(logging.WARNING, logger=VIEWS_LOGGER):
        for _ in range(3):
            assert authenticate_at(
                client, authenticator, body, 0).status_code == 200

    assert regression_events(caplog) == [], caplog.text


def test_zero_is_not_special_once_the_device_has_shown_a_counter():
    """The exemption is "both are 0", not "the presented value is 0". A device
    that has proven it implements the counter cannot then drop back to 0.
    """
    client = Client()
    authenticator = SoftAuthenticator()
    body, response = register(
        client, authenticator, rp_id=RP_ID, origin=RP_ORIGIN)
    assert response.status_code == 200, response.content
    assert authenticate_at(client, authenticator, body, 3).status_code == 200

    assert authenticate_at(client, authenticator, body, 0).status_code == 400
    assert stored_sign_count(body) == 3


def test_counter_beyond_int4_is_storable():
    """``signCount`` is a uint32 (authenticatorData bytes 33-36). The column
    was a Postgres ``integer`` (max 2147483647) back when nothing wrote it; a
    device in the top half of the range would have turned a valid login into a
    500 the moment persistence was added. Migration 0002 widens it.
    """
    client = Client()
    authenticator = SoftAuthenticator()
    body, response = register(
        client, authenticator, rp_id=RP_ID, origin=RP_ORIGIN)
    assert response.status_code == 200, response.content

    highest_uint32 = 4294967295
    auth_response = authenticate_at(
        client, authenticator, body, highest_uint32)
    assert auth_response.status_code == 200, auth_response.content
    assert stored_sign_count(body) == highest_uint32


def test_the_authentication_challenge_is_consumed_on_success():
    """Regression guard for the refactor: challenge deletion moved inside the
    transaction that persists the counter, and must still happen.
    """
    client = Client()
    authenticator = SoftAuthenticator()
    body, response = register(
        client, authenticator, rp_id=RP_ID, origin=RP_ORIGIN)
    assert response.status_code == 200, response.content

    assert authenticate_at(client, authenticator, body, 1).status_code == 200
    assert not WebAuthnChallenge.objects.filter(
        participant__uuid=body["participant_uuid"],
        challenge_type="authentication",
    ).exists()
