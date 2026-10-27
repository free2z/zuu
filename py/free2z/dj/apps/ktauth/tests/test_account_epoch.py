"""``account_epoch`` is a durable counter, and these tests are what says so.

The rule the log applies (``KT.md`` §4.5.4, rules A15 and A18) is modelled here
in:func:`admit` rather than imported, because the implementation of it is a
Rust crate in another repository. That is deliberate and it is the only honest
shape for this file: what is under test is **the value this endpoint puts on
the wire**, and the model is a restatement of the published constants that
``rs/crates/f2z-authority`` asserts against in
``the_published_bounds_are_the_ones_this_crate_applies``. If the two ever
disagree, the cross-repository conformance run is what catches it.

The test that matters is
:func:`test_two_assertions_for_one_ownership_event_are_not_both_spendable`.
Issue  exists because the module docstring of ``signing.issue`` argued
that a clock-derived epoch could only ever cost a legitimate reset a retry --
"both failures are refusals, never acceptances" -- and that argument skips the
case where the two issuances straddle a second boundary. Then the epochs differ,
they increase, and **both assertions stay spendable**. That is an acceptance,
and it is the whole replay window A15 exists to close.
"""

import pytest

from dj.apps.ktauth import epoch as epoch_module
from dj.apps.ktauth import signing
from dj.apps.ktauth.signing import REASON_EPOCH_UNAVAILABLE

pytestmark = pytest.mark.django_db


# --------------------------------------------------------------------------
# A restatement of the log's admission rule for ``account_epoch``.
#
# ``KT.md`` §4.5.4 publishes both bounds as fixed constants precisely so a
# client can apply them without fetching a policy document. These are those
# constants; ``f2z_authority::{ACCOUNT_EPOCH_CEILING, MAX_ACCOUNT_EPOCH_STEP}``
# are the same two numbers.
# --------------------------------------------------------------------------

ACCOUNT_EPOCH_CEILING = 1 << 20
MAX_ACCOUNT_EPOCH_STEP = 16


class Refused(Exception):
    """The log would not admit this assertion. Carries the rule that refused."""


def admit(account_epoch: int, previous: "int | None") -> int:
    """A15 + A18, in the order ``AuthorityConfig::admit`` applies them.

    Returns the value the log retains for the handle; raises:class:`Refused`
    with the rule name if the assertion is unspendable.
    """
    # A18a -- a value this large is not a count of what one account did.
    # Checked on every path, including a first `bind`, which is the only place
    # a clock-derived epoch can be caught before a predecessor exists.
    if account_epoch >= ACCOUNT_EPOCH_CEILING:
        raise Refused("A18a account_epoch_not_a_counter")
    if previous is None:
        return account_epoch
    # A15 -- strict. A reset is a distinct account-ownership event, so an epoch
    # already seen is one that has already been spent.
    if account_epoch <= previous:
        raise Refused("A15 account_epoch_regression")
    # A18b -- and it advanced by an amount a counter could have advanced by.
    if account_epoch > previous + MAX_ACCOUNT_EPOCH_STEP:
        raise Refused("A18b account_epoch_step_too_large")
    return account_epoch


class FakeClock:
    """Stands in for the ``time`` module inside ``signing``.

    ``signing`` uses ``time.time`` for ``issued_ms`` and ``time.monotonic`` for
    the failed-load backoff, so both are provided. Time only moves when a test
    moves it, which is what makes "more than a second apart" a fact about the
    test rather than a hope about the machine it runs on.
    """

    def __init__(self, start_seconds: float):
        self.now = float(start_seconds)

    def time(self) -> float:
        return self.now

    def monotonic(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


#2026-08-24T00:00:00Z, and any wall-clock instant would do. The point is only
#that it is a real Unix time, because the defect was a real Unix time.
START_SECONDS = 1_787_529_600.0


@pytest.fixture
def clock(monkeypatch):
    fake = FakeClock(START_SECONDS)
    monkeypatch.setattr(signing, "time", fake)
    return fake


@pytest.fixture(autouse=True)
def _empty_throttle_bucket():
    """The endpoint allows 10/hour per account; tests must not inherit a bucket."""
    from django.core.cache import cache

    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def caller(api_client, creator_factory):
    user = creator_factory(username="alice")
    api_client.force_authenticate(user=user)
    return user


def account_epoch_of(response) -> int:
    """The ``uint32 account_epoch`` field, read out of the signed bytes.

    Parsed by offset rather than by calling the encoder: a test that re-uses
    the code under test to describe what the code under test produced proves
    only that it is deterministic.
    """
    import base64

    text = response.data["assertion"]
    raw = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    # 1 length byte + label, then authority_id[32] + log_id[32], then
    # 1 length byte + handle, then handle_id[32] + identity_pk[32] + intent.
    cursor = 1 + len(signing.LABEL_ASSERTION_TBS) + 32 + 32
    cursor += 1 + raw[cursor]
    cursor += 32 + 32 + 1
    return int.from_bytes(raw[cursor:cursor + 4], "big")


def mint(api_client, url, identity_key_b64, intent="reset"):
    response = api_client.post(
        url,
        {"identity_key": identity_key_b64, "intent": intent},
        format="json",
    )
    assert response.status_code == 200, response.data
    return response


# --------------------------------------------------------- the defect, pinned


def test_two_assertions_for_one_ownership_event_are_not_both_spendable(
    api_client, caller, url, identity_key_b64, authority, kt_settings, clock
):
    """. The case ``signing.issue``'s old docstring reasoned past.

    One ownership event, two assertions, and the second issuance is on the far
    side of a second boundary from the first. A clock-derived epoch gives them
    two different, increasing values -- so the log admits the first, retains
    it, and then admits the second as well, because a larger number is a larger
    number. A counter gives them the *same* value, and A15 is strict, so the
    second is refused.
    """
    first = mint(api_client, url, identity_key_b64)
    clock.advance(1.5)
    second = mint(api_client, url, identity_key_b64)

    assert second.data["issued_ms"] - first.data["issued_ms"] > 1000, (
        "the two issuances must straddle a second boundary or this test is "
        "not exercising the case it exists for"
    )

    # No ownership event happened between them, so the counter did not move.
    assert account_epoch_of(first) == account_epoch_of(second)

    retained = admit(account_epoch_of(first), previous=None)
    with pytest.raises(Refused, match="A15"):
        admit(account_epoch_of(second), previous=retained)


def test_a_clock_derived_epoch_is_refused_on_its_face(
    api_client, caller, url, identity_key_b64, authority, kt_settings, clock
):
    """A18a, at a first assertion, where A15 has nothing to compare against.

    Unix seconds is about 1.79e9 and the ceiling is 2^20, so the log refuses
    every assertion a clock-derived issuer mints -- which is the other half of
     and the reason the counter had to ship before any log carrying A18
    was put in front of this endpoint.
    """
    response = mint(api_client, url, identity_key_b64, intent="bind")
    value = account_epoch_of(response)

    assert value < ACCOUNT_EPOCH_CEILING
    assert value != int(START_SECONDS)
    admit(value, previous=None)


def test_the_signer_refuses_to_mint_what_the_log_would_refuse_to_admit():
    """The ceiling is enforced where the bytes are built, not only downstream.

    Mirrors ``HandleAssertionTBS::new``, which returns
    ``AccountEpochNotACounter`` rather than constructing a body no log will
    take. An issuer that reaches for ``now // 1000`` because a counter was
    inconvenient finds out at its own keyboard.
    """
    from .conftest import LOG_ID, identity_public_bytes

    kwargs = dict(
        authority_pk=bytes(32),
        log_id=LOG_ID,
        handle=b"alice",
        identity_pk=identity_public_bytes(),
        intent=signing.INTENT_BIND,
        issued_ms=1,
        expires_ms=2,
        nonce=bytes(16),
    )
    signing.encode_assertion_tbs(account_epoch=ACCOUNT_EPOCH_CEILING - 1, **kwargs)
    for rejected in (ACCOUNT_EPOCH_CEILING, int(START_SECONDS), -1):
        with pytest.raises(ValueError, match="account_epoch"):
            signing.encode_assertion_tbs(account_epoch=rejected, **kwargs)


def test_issue_has_no_epoch_default_to_fall_back_to():
    """`reset` must refuse rather than substitute -- and so must `bind`.

    's root cause was a default. The strongest possible statement that no
    clock-derived path remains is that there is no path at all: the parameter
    is required, so a caller that has no counter cannot accidentally get one
    invented for it.
    """
    import inspect

    parameter = inspect.signature(signing.issue).parameters["account_epoch"]
    assert parameter.default is inspect.Parameter.empty
    assert parameter.kind is inspect.Parameter.KEYWORD_ONLY

    with pytest.raises(TypeError):
        signing.issue(
            handle=b"alice",
            identity_pk=bytes(32),
            intent=signing.INTENT_BIND,
        )


# ------------------------------------------------------- the counter, in place


def test_an_ownership_event_makes_the_next_assertion_spendable(
    api_client, caller, url, identity_key_b64, authority, kt_settings, clock
):
    """The other direction: the counter moves, so the log takes the next one."""
    first = mint(api_client, url, identity_key_b64)
    retained = admit(account_epoch_of(first), previous=None)

    epoch_module.bump_account_epoch(
        caller.pk, event=epoch_module.EVENT_PASSWORD_RESET
    )
    clock.advance(1.5)

    second = mint(api_client, url, identity_key_b64)
    assert account_epoch_of(second) == account_epoch_of(first) + 1
    assert admit(account_epoch_of(second), previous=retained) == (
        account_epoch_of(second)
    )


def test_the_endpoint_reads_the_counter_from_the_row_not_from_the_session(
    api_client, caller, url, identity_key_b64, authority, kt_settings
):
    """A stale ``request.user`` must not lower what gets signed.

    Authentication loads the Creator at the start of the request. If the
    counter were read off that instance, an ownership event that committed
    while the request was in flight would be signed away -- which is the
    replay window this counter exists to close, reopened by a cache.
    """
    epoch_module.bump_account_epoch(
        caller.pk, event=epoch_module.EVENT_PASSWORD_RESET
    )
    # `caller` is the very instance the view will see, and it is now stale.
    assert caller.kt_account_epoch == epoch_module.INITIAL_ACCOUNT_EPOCH

    response = mint(api_client, url, identity_key_b64)
    assert account_epoch_of(response) == epoch_module.INITIAL_ACCOUNT_EPOCH + 1


def test_an_ownership_event_during_signing_refuses_the_assertion(
    api_client, caller, url, identity_key_b64, authority, kt_settings, mocker
):
    """Read-then-sign is not atomic, so the value is confirmed before answering.

    Raised by the codex adversarial review: reading the row instead of
    ``request.user`` closes the large window but not the one between the
    ``SELECT`` and the signature. An ownership event that has *committed* by
    the time we would answer must not be handed an assertion carrying the epoch
    the account has already moved past.
    """
    from dj.apps.ktauth import signing as signing_module

    real_issue = signing_module.issue

    def issue_then_change_ownership(**kwargs):
        result = real_issue(**kwargs)
        # Commits between the read and the response, which is precisely the
        # interleaving a test that bumps beforehand cannot reach.
        epoch_module.bump_account_epoch(
            caller.pk, event=epoch_module.EVENT_PASSWORD_RESET
        )
        return result

    mocker.patch.object(
        signing_module, "issue", side_effect=issue_then_change_ownership
    )

    response = api_client.post(
        url,
        {"identity_key": identity_key_b64, "intent": "reset"},
        format="json",
    )

    assert response.status_code == 503, response.data
    assert response.data["reason"] == REASON_EPOCH_UNAVAILABLE
    assert "assertion" not in response.data


def test_a_counter_out_of_range_refuses_rather_than_substituting(
    api_client, caller, url, identity_key_b64, authority, kt_settings
):
    """``KT.md`` §4.5.4: an issuer that cannot read the column MUST refuse.

    Substituting anything -- a clock, a timestamp, a zero -- is what created
    , so the endpoint answers 503 with a bounded reason code instead.
    """
    from dj.apps.g12f.models import Creator

    for unusable in (0, ACCOUNT_EPOCH_CEILING):
        Creator.objects.filter(pk=caller.pk).update(kt_account_epoch=unusable)
        response = api_client.post(
            url,
            {"identity_key": identity_key_b64, "intent": "reset"},
            format="json",
        )
        assert response.status_code == 503, response.data
        assert response.data["reason"] == REASON_EPOCH_UNAVAILABLE
        assert "assertion" not in response.data


def test_a_full_save_cannot_write_the_counter_backwards(caller):
    """The stale-clobber shape of /, on a security counter this time.

    ``ModelSerializer.update`` and ``SetPasswordForm.save`` both end in a bare
    ``instance.save()`` on an instance that was loaded before the bump. If the
    counter were an ordinary column, a password change would increment it and
    then immediately write the old value back over it -- in the same request.
    """
    from dj.apps.g12f.models import Creator

    stale = Creator.objects.get(pk=caller.pk)
    epoch_module.bump_account_epoch(
        caller.pk, event=epoch_module.EVENT_PASSWORD_RESET
    )

    stale.full_name = "still writable"
    stale.save()

    refreshed = Creator.objects.get(pk=caller.pk)
    assert refreshed.full_name == "still writable"
    assert refreshed.kt_account_epoch == epoch_module.INITIAL_ACCOUNT_EPOCH + 1
    #...and the in-memory instance is resynced rather than left lying.
    assert stale.kt_account_epoch == epoch_module.INITIAL_ACCOUNT_EPOCH + 1


def test_the_counter_starts_inside_the_ceiling_and_above_zero(caller):
    """Existing accounts get a starting value, and it is a usable one."""
    assert epoch_module.INITIAL_ACCOUNT_EPOCH == 1
    assert caller.kt_account_epoch == epoch_module.INITIAL_ACCOUNT_EPOCH
    admit(caller.kt_account_epoch, previous=None)


def test_every_declared_ownership_event_is_named_in_the_docstring():
    """The enumeration *is* the security property, so it cannot drift silently.

    An event added to the code without a line in the docstring explaining why
    it invalidates outstanding assertions is exactly the kind of undocumented
    security decision  was.
    """
    for event in epoch_module.OWNERSHIP_EVENTS:
        assert event in epoch_module.__doc__, event


def test_an_unknown_event_name_is_refused():
    """A typo at a call site must not silently become an unlogged bump."""
    with pytest.raises(ValueError, match="ownership event"):
        epoch_module.bump_account_epoch(1, event="whatever")
