""": a solved reCAPTCHA must not authorise unlimited credential guesses.

Read the module docstring of ``dj/apps/g12f/captcha.py`` first; this file is
the evidence for it.

Every test here was run against the pre-fix code and made to fail before it was
trusted (the negative-control output is in the PR body). Two of them are
*availability* tests rather than security tests — they fail if the fix breaks
sign-in — and those matter just as much, because the reason this bug survived
so long is that the obvious fix ("stop accepting duplicates") locks every user
out of the site.

Why the existing suite could not catch the bug (issue 's own words): no
test ever performed two ``siteverify`` calls with the same token. The browser
test mocked the second response as successful; the backend tests monkeypatch
``requests.post`` to a single canned answer. So the fail-open branch was never
exercised against Google's *actual* duplicate response. ``_google`` below is
the missing piece: one stub, statefully answering the way Google documents —
``success`` exactly once per token, ``timeout-or-duplicate`` forever after.
"""

import pathlib
import time
from datetime import datetime, timedelta, timezone as dt_timezone
from types import SimpleNamespace
from unittest import mock

import pyotp
import pyotp.totp
import pytest
from django.core.cache import cache
from django.test import override_settings
from django.utils import timezone

from dj.apps.g12f.captcha import (
    CAPTCHA_GRANT_ARMING_EVENT,
    CAPTCHA_GRANT_FAIL_OPEN_EVENT,
    CAPTCHA_GRANT_MAX_USES,
    CAPTCHA_TOKEN_LIFETIME_SECONDS,
    _enforcement_stamp_key,
    _grant_key,
    _grant_ttl,
    stamp_enforcement_clock,
    verify_captcha_response,
)
from dj.apps.otp.models import OTPSecret

SITEVERIFY = "https://www.google.com/recaptcha/api/siteverify"


@pytest.fixture(autouse=True)
def _clear_grant_store():
    """Grants live in the process-local cache and leak between tests."""
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def armed():
    """Put the module in its STEADY STATE, a day after the feature shipped.

    Enforcement is deliberately inert until a grant-writing pod has been
    serving longer than a rolling deploy can last, so that the deploy which
    introduces  cannot refuse a CAPTCHA an old pod redeemed. Every test
    below that asserts a REFUSAL is asserting steady-state behaviour, so it
    has to say so explicitly rather than accidentally test the rollout window.
    ``test_enforcement_is_inert_until_the_rollout_window_has_passed`` covers
    the other side.
    """
    cache.set(_enforcement_stamp_key(), time.time() - 86400, None)
    return True


class _google:
    """A stateful stand-in for Google's ``siteverify``, per its own docs.

    The one behaviour that matters and that no previous test reproduced: a
    given response token verifies **once**. Every later call with the same
    token returns ``success: false`` with ``error-codes:
    ["timeout-or-duplicate"]`` — the same answer it gives for a token that
    simply aged out. That single ambiguous code is the entire bug.

    ``redeemed`` doubles as a call log, so a test can assert the network was
    (or was not) reached.
    """

    def __init__(self, *, already_redeemed=(), challenge_ts=None):
        self.redeemed = list(already_redeemed)
        self.challenge_ts = challenge_ts

    def __call__(self, url, **kwargs):
        assert url == SITEVERIFY, url
        token = kwargs.get("data", {}).get("response", "")
        if token in self.redeemed:
            payload = {
                "success": False,
                "error-codes": ["timeout-or-duplicate"],
            }
        else:
            self.redeemed.append(token)
            payload = {
                "success": True,
                "challenge_ts": self.challenge_ts or (
                    timezone.now().isoformat().replace("+00:00", "Z")
                ),
                "hostname": "free2z.cash",
            }
        return SimpleNamespace(json=lambda: payload)


class _MultiPatch:
    """Point BOTH captcha call sites at one stub.

    They have to share it. The whole flow under test is that ``/api/start/``
    redeems the token and ``/api/auth/login/`` then presents the spent one, so
    a per-module stub would quietly turn the second leg back into a first leg
    and test nothing. both legs reach Google through the one
    ``dj.apps.g12f.captcha.siteverify``, so one patch covers both; patching the
    same target twice would leak the stub (the second patch saves the first
    one's stub as "original" and restores it on stop).
    """

    def __init__(self, google):
        self._patches = [
            mock.patch("dj.apps.g12f.captcha.requests.post", google),
        ]

    def __enter__(self):
        for p in self._patches:
            p.start()
        return self

    def __exit__(self, *exc):
        for p in self._patches:
            p.stop()
        return False


def _login(api_client, username, password, token, otp=None):
    body = {
        "username": username,
        "password": password,
        "captcha_result": token,
    }
    if otp is not None:
        body["otp_token"] = otp
    return api_client.post("/api/auth/login/", body, format="json")


def _freeze_totp_clock(monkeypatch):
    """Pin PyOTP's clock and the OTP verifier to one stable TOTP step."""
    frozen_now = datetime(2030, 1, 1, 12, 34, 15, tzinfo=dt_timezone.utc)
    frozen_timestamp = int(frozen_now.timestamp())

    class FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            if tz is None:
                return cls.fromtimestamp(frozen_timestamp)
            return cls.fromtimestamp(frozen_timestamp, tz)

    # PyOTP's at()/verify() isinstance-checks for_time against the class it
    # imports as pyotp.totp.datetime.datetime.
    monkeypatch.setattr(
        pyotp.totp, "datetime", SimpleNamespace(datetime=FrozenDateTime)
    )

    import dj.apps.otp.utils as otp_utils

    class FrozenTimezone:
        @staticmethod
        def now():
            return FrozenDateTime.fromtimestamp(
                frozen_timestamp, tz=dt_timezone.utc
            )

    # the verifier captures this instant and passes it to PyOTP;
    # keep generation and verification on the same instant for this test.
    monkeypatch.setattr(otp_utils, "timezone", FrozenTimezone)
    return pyotp.TOTP("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")


# ---------------------------------------------------------------------------
# The vulnerability
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_a_captcha_token_this_server_never_granted_is_refused(
    api_client, creator_factory, armed
):
    """THE bug, in the attacker's own shape.

    An attacker solves one CAPTCHA somewhere (or buys one, or keeps an old
    one) and then POSTs ``/api/auth/login/`` with it forever. Google answers
    ``timeout-or-duplicate`` every single time, and the pre- line

        recaptcha_success = r.json().get('success') or error_code == '...'

    read that as a pass. Nothing else on this endpoint limited anything, so
    that was unlimited free credential stuffing.

    The token here is marked already-redeemed before the first request, so
    this server has never opened a grant for it — which is exactly the state
    of any token an attacker did not just solve in our page.
    """
    user = creator_factory(password="correct-password")
    google = _google(already_redeemed=["stolen-token"])

    with _MultiPatch(google):
        response = _login(
            api_client, user.username, "correct-password", "stolen-token"
        )

    assert response.status_code == 400, response.content
    assert "Invalid captcha" in response.content.decode(), response.content
    assert google.redeemed == ["stolen-token"], (
        "siteverify should still have been consulted exactly once"
    )


@pytest.mark.django_db
def test_one_solved_captcha_buys_a_bounded_number_of_guesses(
    api_client, creator_factory, armed
):
    """Replay is bounded, not unlimited — and the boundary is observable.

    The duplicate branch cannot simply be deleted (MFA and the two-request
    sign-in dance both depend on it), so the property is a *budget*: one solve
    authorises ``CAPTCHA_GRANT_MAX_USES`` presentations and no more.

    Every attempt below uses a wrong password, which is what credential
    stuffing looks like, so the assertion is on the error CHANGING: the first
    ``CAPTCHA_GRANT_MAX_USES`` attempts get as far as the credential check
    (the captcha passed), and the next one never does.
    """
    user = creator_factory(password="correct-password")
    google = _google()
    token = "one-real-solve"

    with _MultiPatch(google):
        within_budget = [
            _login(api_client, user.username, f"guess-{i}", token)
            for i in range(CAPTCHA_GRANT_MAX_USES)
        ]
        over_budget = _login(
            api_client, user.username, "guess-over", token
        )

    for i, response in enumerate(within_budget):
        body = response.content.decode()
        assert response.status_code == 400, (i, body)
        assert "Invalid captcha" not in body, (
            f"guess {i} was refused for the captcha rather than the password, "
            "so the budget is smaller than CAPTCHA_GRANT_MAX_USES and MFA "
            f"sign-in is broken: {body}"
        )

    assert over_budget.status_code == 400, over_budget.content
    assert "Invalid captcha" in over_budget.content.decode(), (
        "the grant budget never ran out, so one solved captcha still buys "
        f"unlimited guesses: {over_budget.content!r}"
    )
    assert google.redeemed == [token], (
        "the token should have been presented to Google every time and "
        "verified only once"
    )


@pytest.mark.django_db
def test_an_expired_grant_ends_the_replay(api_client, creator_factory, armed):
    """Same token, twice, second one refused — because the grant aged out.

    Retention is Google's own ~2 minute token lifetime, so a token that is
    still being replayed after that is a token Google itself would no longer
    honour. ``cache.clear()`` between the two requests is precisely what
    expiry does to the record, without reaching into the key format or
    sleeping through a real TTL.
    """
    user = creator_factory(password="correct-password")
    google = _google()
    token = "aging-token"

    with _MultiPatch(google):
        first = _login(api_client, user.username, "correct-password", token)
        assert first.status_code == 204, first.content

        # The grant's TTL elapsed. cache.clear() also drops the arming stamp,
        # which is not what expiry does to it (it has no expiry), so put the
        # steady state back rather than accidentally testing the rollout
        # window -- the failure this guards against is subtle: without the
        # re-stamp this test passes for the WRONG reason on unfixed code too.
        cache.clear()
        cache.set(_enforcement_stamp_key(), time.time() - 86400, None)

        second = _login(api_client, user.username, "correct-password", token)

    assert second.status_code == 400, second.content
    assert "Invalid captcha" in second.content.decode(), second.content


# ---------------------------------------------------------------------------
# Availability: the reason the naive fix is not shippable
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_the_two_request_sign_in_dance_still_works(
    api_client, creator_factory
):
    """The availability test. If this breaks, EVERY existing user is locked out.

    Both front ends POST ``/api/start/`` first on every authentication attempt
    and fall through to ``/api/auth/login/`` with the SAME token when signup
    reports the user already exists. ``/api/start/`` redeems the token at
    Google, so the login leg is *always* a duplicate in production. Rejecting
    duplicates outright — the obvious reading of "make the captcha single
    use" — is a total sign-in outage.
    """
    user = creator_factory(password="correct-password")
    google = _google()
    token = "one-token-two-legs"

    with _MultiPatch(google):
        signup = api_client.post(
            "/api/start/",
            {
                "username": user.username,
                "password": "correct-password",
                "captcha_result": token,
            },
            format="json",
        )
        # The exact refusal the two-request dance depends on: the
        # captcha PASSED (not 406) and signup then refused only because the
        # username is taken -- which is what makes both UIs fall through to
        # /api/auth/login/. "not 200/201 and not 406" also passed on a 404
        # (route moved), a 405 or a 500, none of which the UIs fall through on.
        # The body is what the UIs actually match on to fall through
        # (`isAccountExistsError` in ts/svelte/free2z/src/lib/stores/auth.ts).
        assert signup.status_code == 400 and (
            b"A user with that username already exists." in signup.content
        ), (
            "fixture user should already exist, so /api/start/ must refuse "
            "with the username-taken 400 after the captcha passed: "
            f"{signup.status_code} {signup.content!r}"
        )

        login = _login(api_client, user.username, "correct-password", token)

    assert login.status_code == 204, (
        "the second leg of the sign-in dance was refused. In production this "
        "is every existing account unable to log in at all: "
        f"{login.status_code} {login.content!r}"
    )
    assert google.redeemed == [token]


@pytest.mark.django_db
def test_mfa_can_retry_the_otp_code_on_one_captcha(
    api_client, creator_factory, monkeypatch
):
    """OTPModal re-POSTs login with the same captcha token per typed code.

    It never re-executes reCAPTCHA, so each retry is another duplicate. A
    budget of 1 or 2 would make MFA sign-in impossible for anyone who fumbles
    a digit — which is the failure  explicitly deferred to this issue.
    """
    secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
    totp = _freeze_totp_clock(monkeypatch)
    user = creator_factory(password="correct-password")
    OTPSecret.objects.create(user=user, secret=secret, is_active=True)

    google = _google()
    token = "mfa-token"

    with _MultiPatch(google):
        # Leg 1 + leg 2 of the dance, then two fumbled codes, then the code.
        api_client.post(
            "/api/start/",
            {
                "username": user.username,
                "password": "correct-password",
                "captcha_result": token,
            },
            format="json",
        )
        no_code = _login(
            api_client, user.username, "correct-password", token
        )
        assert no_code.status_code == 400, no_code.content
        assert "OTP" in no_code.content.decode(), no_code.content

        for wrong in ("000000", "111111"):
            bad = _login(
                api_client, user.username, "correct-password", token, otp=wrong
            )
            assert bad.status_code == 400, bad.content
            assert "Invalid captcha" not in bad.content.decode(), (
                "an OTP retry was refused for the CAPTCHA. The user has no "
                f"way out of that loop: {bad.content!r}"
            )

        good = _login(
            api_client,
            user.username,
            "correct-password",
            token,
            otp=totp.now(),
        )

    assert good.status_code == 204, good.content


# ---------------------------------------------------------------------------
# /api/start/ — the other captcha-protected endpoint
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_signup_still_refuses_a_duplicate_token(api_client):
    """Regression guard, not a fix: ``/api/start/`` never accepted duplicates.

    It is always leg 1 of the dance, so ``allow_replay=False``. Recorded here
    because  put a shared helper on this path and the easy mistake is to
    pass ``allow_replay=True`` everywhere "for consistency", which would hand
    the registration endpoint the replay hole that login just lost.
    """
    google = _google()
    token = "signup-token"
    body = {
        "username": "brand-new-816",
        "password": "a-perfectly-fine-password",
        "captcha_result": token,
    }

    with _MultiPatch(google):
        first = api_client.post("/api/start/", body, format="json")
        assert first.status_code == 201, first.content

        second = api_client.post(
            "/api/start/", {**body, "username": "another-new-816"},
            format="json",
        )

    assert second.status_code == 406, second.content
    assert b"ReCAPTCHA not verified" in second.content


# ---------------------------------------------------------------------------
# The rolling deploy that introduces this
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_enforcement_is_inert_until_the_rollout_window_has_passed(
    api_client, creator_factory, caplog
):
    """The deploy that ships  must not refuse a real user's password.

    Prod is 5 replicas, ``maxSurge: 50%``, no session affinity, and
    ``terminationGracePeriodSeconds: 600`` — so during THIS deploy an OLD pod
    can serve ``/api/start/`` (redeeming the token at Google, writing no grant)
    while a NEW pod serves the ``/api/auth/login/`` that follows. Redis is
    healthy, the liveness probe passes, no grant exists. Refusing there tells a
    user with correct credentials "Invalid captcha", intermittently, for the
    whole rollout, with every health check green — and CI can never see it,
    because CI only ever runs one homogeneous tree.

    So enforcement stays inert until a grant-writing pod has been serving
    longer than a rollout can last. Note this fixture does NOT request
    ``armed``: the stamp is fresh, which is exactly the state of the fleet
    the minute this ships.
    """
    user = creator_factory(password="correct-password")
    google = _google(already_redeemed=["redeemed-by-an-old-pod"])
    stamp_enforcement_clock(time.time())

    with _MultiPatch(google), \
            caplog.at_level("WARNING", logger="dj.apps.g12f.captcha"):
        response = _login(
            api_client,
            user.username,
            "correct-password",
            "redeemed-by-an-old-pod",
        )

    assert response.status_code == 204, (
        "the introducing deploy refused a CAPTCHA an old pod had redeemed. "
        "In production that is intermittent sign-in failure for the whole "
        f"rollout: {response.status_code} {response.content!r}"
    )
    assert any(
        CAPTCHA_GRANT_ARMING_EVENT in record.getMessage()
        for record in caplog.records
    ), (
        "the un-armed window was silent, so nobody can tell whether the "
        "defence is on: "
        f"{[r.getMessage() for r in caplog.records]}"
    )


@pytest.mark.django_db
def test_the_arming_stamp_is_written_once_and_never_moved(api_client):
    """The window opens ONCE, for one deploy — not on every deploy.

    ``cache.add`` with no expiry: the first grant-writing pod stamps the
    instant, every later pod and every later deploy leaves it alone. A
    per-process warm-up instead of a shared stamp would re-open the hole on
    every deploy and every pod restart, several times a day, forever.
    """
    original = time.time() - 86400
    cache.set(_enforcement_stamp_key(), original, None)

    google = _google()
    with _MultiPatch(google):
        api_client.post(
            "/api/start/",
            {
                "username": "stamp-check-816",
                "password": "a-perfectly-fine-password",
                "captcha_result": "stamp-check-token",
            },
            format="json",
        )

    assert cache.get(_enforcement_stamp_key()) == original, (
        "a later pod moved the arming stamp forward, which re-opens the "
        "mixed-fleet window on every single deploy"
    )


def test_the_documented_rollback_key_is_the_key_redis_actually_holds():
    """The one escape hatch for a rollback-induced auth outage must work.

    ``CAPTCHA_GRANT_MIXED_FLEET_SECONDS`` documents a raw ``DEL`` for the
    operator who has to disarm enforcement before a late manual rollback. The
    first draft of that line was WRONG in two ways at once (codex adversarial
    review, round 3): it used ``<DBNAME>`` as a Redis prefix, and it omitted
    Django's version segment.

    Neither mistake is visible anywhere. ``OPTIONS["PREFIX"]`` on the prod
    cache looks exactly like a key prefix and django-redis ignores it entirely
    -- the top-level ``KEY_PREFIX`` is a different setting -- so the real
    prefix is empty and ``default_key_func`` contributes ``:1:``. The failure
    mode is a 3am ``DEL`` that reports success, deletes nothing, leaves every
    pod armed, and lets correct passwords keep failing for two 600-second
    drains with no probe and no alert moving.

    So the docstring's literal string is asserted against what
    ``cache.make_key`` actually produces. LocMem and prod agree here: neither
    sets ``KEY_PREFIX``, both are at version 1.
    """
    import re

    from dj.apps.g12f import captcha as captcha_module

    documented = re.search(
        r"^#:\s+DEL (\S+)$", captcha_module.__doc__ or "", re.MULTILINE
    )
    if documented is None:
        # The constant's comment is not part of __doc__; read the source.
        source = pathlib.Path(captcha_module.__file__).read_text()
        documented = re.search(r"^#:\s+DEL (\S+)$", source, re.MULTILINE)
    assert documented, "the rollback DEL command vanished from the docstring"

    with override_settings(CAPTCHA_GRANT_NAMESPACE="prod"):
        real = cache.make_key(_enforcement_stamp_key())
    assert documented.group(1).replace("<DBNAME>", "prod") == real, (
        "the documented rollback command targets a key Redis does not hold. "
        f"documented={documented.group(1)!r} real={real!r}"
    )


@pytest.mark.django_db
def test_stage_cannot_arm_production_through_the_shared_redis(
    api_client, creator_factory
):
    """Every key here must carry the database environment ( codex).

    Stage, test and production deliberately share Redis database 1, and
    django-redis's ``OPTIONS["PREFIX"]`` is **not** its top-level
    ``KEY_PREFIX`` -- it isolates nothing. The arming stamp has no expiry, so
    an unnamespaced key would let one CAPTCHA served by stage write
    ``writer-since`` days before  reached production. Production would then
    consider itself armed from the first second of its own rolling deploy, and
    refuse the second leg of every CAPTCHA an old pod had redeemed: correct
    credentials, "Invalid captcha", every probe green.

    pytest runs one LocMem cache under one settings module and can never model
    two ``DBNAME`` environments sharing Redis, so this is asserted the only way
    it can be: the environment appears in the key, and switching it makes the
    stamp another environment wrote invisible.
    """
    other_env_stamp = time.time() - 86400
    with override_settings(CAPTCHA_GRANT_NAMESPACE="stage"):
        stage_key = _enforcement_stamp_key()
        cache.set(stage_key, other_env_stamp, None)

    with override_settings(CAPTCHA_GRANT_NAMESPACE="prod"):
        prod_key = _enforcement_stamp_key()
        assert prod_key != stage_key, (
            "the arming stamp is shared between environments; stage can arm "
            "production before it has ever deployed this code"
        )
        assert cache.get(prod_key) is None, (
            "production read an arming stamp another environment wrote"
        )

        # And the same for a grant: one environment must not satisfy or spend
        # another's. Same shared Redis, same reasoning one layer down.
        user = creator_factory(password="correct-password")
        google = _google()
        with _MultiPatch(google):
            api_client.post(
                "/api/start/",
                {
                    "username": user.username,
                    "password": "correct-password",
                    "captcha_result": "cross-env-token",
                },
                format="json",
            )
        prod_grant = _grant_key("cross-env-token")

    with override_settings(CAPTCHA_GRANT_NAMESPACE="stage"):
        assert _grant_key("cross-env-token") != prod_grant, (
            "grants are shared between environments"
        )


# ---------------------------------------------------------------------------
# The degraded mode
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_an_unreachable_grant_store_degrades_open_and_says_so(
    api_client, creator_factory, caplog
):
    """A Redis outage must NOT become a site-wide sign-in outage.

    ``prod_settings.py`` allows the TOTP counter to fail closed only because
    "``/api/auth/login/`` carries no such counter, so ordinary sign-in still
    works".  puts a counter on that exact path, so it has to degrade the
    other way — and say so on a stable, countable event, because a defence
    that has been silently off for a week is otherwise invisible.

    ``IGNORE_EXCEPTIONS: True`` in production means the failure arrives as
    ``None``/default rather than an exception, which is why the store is
    probed by writing a value and reading it back rather than by catching
    something. This stub reproduces that exact shape: every read is a miss,
    every write is discarded, nothing raises.
    """
    user = creator_factory(password="correct-password")
    google = _google(already_redeemed=["replayed-during-outage"])

    class _SwallowingCache:
        def get(self, key, default=None, **kwargs):
            return default

        def set(self, *args, **kwargs):
            return None

        def add(self, *args, **kwargs):
            return None

        def delete(self, *args, **kwargs):
            return None

        def incr(self, key, delta=1, **kwargs):
            return None

    with _MultiPatch(google), \
            mock.patch("dj.apps.g12f.captcha.cache", _SwallowingCache()), \
            caplog.at_level("WARNING", logger="dj.apps.g12f.captcha"):
        response = _login(
            api_client,
            user.username,
            "correct-password",
            "replayed-during-outage",
        )

    assert response.status_code == 204, (
        "a cache outage refused a sign-in. That is not a degraded feature, it "
        f"is the whole site's auth: {response.status_code} {response.content!r}"
    )
    assert any(
        CAPTCHA_GRANT_FAIL_OPEN_EVENT in record.getMessage()
        for record in caplog.records
    ), (
        "the degraded mode was silent. Nothing 429s, nothing 500s and replay "
        "protection is simply off — this log line is the only trace: "
        f"{[r.getMessage() for r in caplog.records]}"
    )


# ---------------------------------------------------------------------------
# Unit-level: retention comes from Google's answer, not from a constant
# ---------------------------------------------------------------------------


def test_grant_ttl_is_derived_from_challenge_ts():
    now = timezone.now()

    fresh = _grant_ttl(
        {"challenge_ts": now.isoformat().replace("+00:00", "Z")}, now=now
    )
    assert fresh == CAPTCHA_TOKEN_LIFETIME_SECONDS

    aged = _grant_ttl(
        {
            "challenge_ts": (
                now - timedelta(seconds=90)
            ).isoformat().replace("+00:00", "Z")
        },
        now=now,
    )
    assert aged == CAPTCHA_TOKEN_LIFETIME_SECONDS - 90

    # A challenge_ts from the future (remote clock ahead of ours, or a hostile
    # value) must not mint a grant that outlives Google's own token.
    skewed = _grant_ttl(
        {
            "challenge_ts": (
                now + timedelta(hours=1)
            ).isoformat().replace("+00:00", "Z")
        },
        now=now,
    )
    assert skewed == CAPTCHA_TOKEN_LIFETIME_SECONDS

    # Already older than the token lifetime: clamped to a positive timeout,
    # because 0 means "expire immediately" to Django and would refuse the very
    # next leg of the dance.
    stale = _grant_ttl(
        {
            "challenge_ts": (
                now - timedelta(hours=1)
            ).isoformat().replace("+00:00", "Z")
        },
        now=now,
    )
    assert stale == 1

    # Missing / unparseable: fall back to the full lifetime rather than
    # refusing. A self-hosted or stubbed verifier does not send one.
    assert _grant_ttl({}, now=now) == CAPTCHA_TOKEN_LIFETIME_SECONDS
    assert (
        _grant_ttl({"challenge_ts": "not-a-timestamp"}, now=now)
        == CAPTCHA_TOKEN_LIFETIME_SECONDS
    )


def test_only_the_duplicate_error_code_may_replay():
    """Every other failure stays a failure, and never touches the grant store.

    The pre- code read ``error-codes[0]``. Google may return several
    codes, so membership is the right test — but it must stay membership of
    exactly ONE code: ``invalid-input-secret`` (our key is wrong) or
    ``invalid-input-response`` (the token is garbage) were never a solve.
    """
    assert verify_captcha_response(
        {"success": False, "error-codes": ["invalid-input-response"]},
        "t", allow_replay=True,
    ) is False
    assert verify_captcha_response(
        {"success": False, "error-codes": ["invalid-input-secret"]},
        "t", allow_replay=True,
    ) is False
    assert verify_captcha_response(
        {"success": False}, "t", allow_replay=True
    ) is False
    assert verify_captcha_response(None, "t", allow_replay=True) is False
    assert verify_captcha_response(
        {"success": False, "error-codes": "timeout-or-duplicate"},
        "t", allow_replay=True,
    ) is False, "a bare string must not be membership-tested character-wise"
