"""Recovery codes: hashed at rest, ten per account, single use.

Real Postgres. The concurrency test runs two real database sessions in two
threads and holds the first one's transaction open until Postgres reports
the second one waiting on its lock, so the interleaving is forced rather
than hoped for. Its negative control runs the same harness against the
read-then-write shape a naive implementation would have, and shows that
shape spending one code twice.
"""
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from django.core.exceptions import ImproperlyConfigured
from django.db import close_old_connections, connection, connections, transaction
from django.db.models import F
from django.utils import timezone

from dj.apps.g12f.models import Creator
from dj.apps.identity import recovery
from dj.apps.identity.models import RecoveryCode
from dj.apps.identity.recovery import (
    RECOVERY_CODE_COUNT,
    StaleAuthentication,
    code_digest,
    consume_recovery_code,
    issue_recovery_codes,
    normalize_code,
    remaining_recovery_codes,
)


def _fresh(user):
    return Creator.objects.get(pk=user.pk)


@pytest.fixture(autouse=True)
def configured_secret_key(settings):
    """The test process has no SECRET_KEY env var, so settings fell back to
    a random key and flagged it. Tests model a configured deployment; the
    refusal itself is tested explicitly below.
    """
    settings.SECRET_KEY_IS_EPHEMERAL = False
    return settings


def _ownership_event(user):
    """An ownership event, reduced to its counter (setup only)."""
    Creator.objects.filter(pk=user.pk).update(
        kt_account_epoch=F("kt_account_epoch") + 1,
    )


# --------------------------------------------------------------------------- #
# Issue, store, spend
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_an_account_gets_ten_distinct_codes(creator_factory):
    user = _fresh(creator_factory())
    codes = issue_recovery_codes(user)
    assert len(codes) == RECOVERY_CODE_COUNT == 10
    assert len({normalize_code(c) for c in codes}) == 10
    assert all(len(c) == 19 and c.count("-") == 3 for c in codes)
    assert remaining_recovery_codes(user) == 10
    assert set(
        RecoveryCode.objects.filter(creator=user).values_list("issued_at_epoch", flat=True)
    ) == {user.kt_account_epoch}


@pytest.mark.django_db
def test_codes_are_stored_as_keyed_hashes_only(creator_factory):
    user = _fresh(creator_factory())
    codes = issue_recovery_codes(user)
    stored = set(RecoveryCode.objects.filter(creator=user).values_list("digest", flat=True))
    for code in codes:
        normalized = normalize_code(code)
        assert normalized not in stored and code not in stored
        assert code_digest(user.pk, normalized) in stored
    for digest in stored:
        assert all(normalize_code(c) not in digest for c in codes)


@pytest.mark.django_db
def test_a_code_spends_once(creator_factory):
    user = _fresh(creator_factory())
    code = issue_recovery_codes(user)[0]
    assert consume_recovery_code(user, code) is True
    assert consume_recovery_code(user, code) is False
    assert remaining_recovery_codes(user) == 9


@pytest.mark.django_db
def test_a_code_is_read_forgivingly(creator_factory):
    user = _fresh(creator_factory())
    codes = issue_recovery_codes(user)
    typed = " " + codes[0].lower().replace("-", " ") + "\n"
    assert consume_recovery_code(user, typed) is True

    # Crockford base32: I and L read as 1, O as 0.
    confusable = codes[1].replace("1", "l").replace("0", "o")
    assert consume_recovery_code(user, confusable) is True


@pytest.mark.django_db
@pytest.mark.parametrize("junk", ["", "x", "0000-0000-0000", "U" * 16, None, 12345])
def test_malformed_input_spends_nothing(creator_factory, junk):
    user = _fresh(creator_factory())
    issue_recovery_codes(user)
    assert consume_recovery_code(user, junk) is False
    assert remaining_recovery_codes(user) == 10


@pytest.mark.django_db
def test_a_code_works_only_for_its_own_account(creator_factory):
    a, b = _fresh(creator_factory()), _fresh(creator_factory())
    code = issue_recovery_codes(a)[0]
    issue_recovery_codes(b)
    assert consume_recovery_code(b, code) is False
    assert consume_recovery_code(a, code) is True


@pytest.mark.django_db
def test_issuing_a_new_set_retires_the_old_one(creator_factory):
    user = _fresh(creator_factory())
    old = issue_recovery_codes(user)
    consume_recovery_code(user, old[0])
    new = issue_recovery_codes(user)
    assert RecoveryCode.objects.filter(creator=user).count() == 10
    assert remaining_recovery_codes(user) == 10
    assert consume_recovery_code(user, old[1]) is False
    assert consume_recovery_code(user, new[1]) is True


@pytest.mark.django_db
def test_a_rotated_secret_key_still_verifies_through_the_fallbacks(
    creator_factory, settings,
):
    """Rotating ``SECRET_KEY`` the documented Django way (old key moved to
    ``SECRET_KEY_FALLBACKS``) must not lock people out of their codes.
    """
    settings.SECRET_KEY = "old-key-" + "x" * 50
    user = _fresh(creator_factory())
    codes = issue_recovery_codes(user)

    settings.SECRET_KEY = "new-key-" + "y" * 50
    settings.SECRET_KEY_FALLBACKS = []
    # Negative: without the fallback the old digests are unreachable.
    assert consume_recovery_code(user, codes[0]) is False

    settings.SECRET_KEY_FALLBACKS = ["old-key-" + "x" * 50]
    assert consume_recovery_code(user, codes[0]) is True

    # A set issued after the rotation is keyed with the new key.
    fresh = issue_recovery_codes(user)
    settings.SECRET_KEY_FALLBACKS = []
    assert consume_recovery_code(user, fresh[0]) is True


@pytest.mark.django_db
def test_a_rolled_back_spend_leaves_the_code_unspent(creator_factory):
    user = _fresh(creator_factory())
    code = issue_recovery_codes(user)[0]
    with pytest.raises(RuntimeError), transaction.atomic():
        assert consume_recovery_code(user, code) is True
        raise RuntimeError("the action the code paid for failed")
    assert consume_recovery_code(user, code) is True


# --------------------------------------------------------------------------- #
# Epoch binding: an ownership event retires every earlier set
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_codes_issued_before_an_ownership_event_are_refused(creator_factory):
    """Someone who briefly held the account minted a set; the owner then
    reset the password. The set must not survive the reset.
    """
    user = _fresh(creator_factory())
    planted = issue_recovery_codes(user)
    # Control: the set works before the event, so the refusal below is the
    # epoch and not a broken code.
    assert consume_recovery_code(user, planted[0]) is True

    stale_copy = user  # still carries the pre-event epoch
    _ownership_event(user)
    assert consume_recovery_code(stale_copy, planted[1]) is False
    assert consume_recovery_code(_fresh(user), planted[2]) is False
    assert remaining_recovery_codes(user) == 0
    # Refused, not spent: only the control spend is recorded.
    assert RecoveryCode.objects.filter(creator=user, used_at__isnull=False).count() == 1


@pytest.mark.django_db
def test_a_set_issued_after_the_event_works(creator_factory):
    user = _fresh(creator_factory())
    issue_recovery_codes(user)
    _ownership_event(user)
    current = _fresh(user)
    fresh = issue_recovery_codes(current)
    assert set(RecoveryCode.objects.filter(creator=user)
               .values_list("issued_at_epoch", flat=True)) == {
        current.kt_account_epoch}
    assert remaining_recovery_codes(user) == 10
    assert consume_recovery_code(current, fresh[0]) is True


@pytest.mark.django_db
def test_a_request_from_before_the_event_cannot_issue_a_set(creator_factory):
    """The attacker's request authenticated at epoch N; the owner reset the
    password (N+1) before that request reached the issuer. It must not mint
    a set stamped N+1 (codex adversarial review).
    """
    user = _fresh(creator_factory())
    owners = issue_recovery_codes(user)
    attackers_request_user = _fresh(user)  # loaded at authentication, epoch N
    _ownership_event(user)
    owner_now = _fresh(user)
    owners_new = issue_recovery_codes(owner_now)  # control: current caller works

    with pytest.raises(StaleAuthentication):
        issue_recovery_codes(attackers_request_user)
    with pytest.raises(StaleAuthentication):
        issue_recovery_codes(
            owner_now, account_epoch=attackers_request_user.kt_account_epoch)
    # Refused before touching anything: the owner's new set is intact.
    assert remaining_recovery_codes(user) == 10
    assert consume_recovery_code(owner_now, owners_new[0]) is True
    assert consume_recovery_code(owner_now, owners[1]) is False


@pytest.mark.django_db
def test_the_real_ownership_event_retires_the_codes(creator_factory):
    """Through ``bump_account_epoch`` itself, not only the counter."""
    from dj.apps.ktauth.epoch import EVENT_PASSWORD_RESET, bump_account_epoch

    user = _fresh(creator_factory())
    codes = issue_recovery_codes(user)
    with transaction.atomic():
        bump_account_epoch(user.pk, event=EVENT_PASSWORD_RESET)
    assert consume_recovery_code(user, codes[0]) is False


# --------------------------------------------------------------------------- #
# Fail closed on an unconfigured SECRET_KEY
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
@pytest.mark.parametrize("flag", [True, "yes", None])
def test_codes_are_refused_while_the_secret_key_is_ephemeral(
    creator_factory, configured_secret_key, flag,
):
    user = _fresh(creator_factory())
    codes = issue_recovery_codes(user)  # control: works while configured

    if flag is None:
        del configured_secret_key.SECRET_KEY_IS_EPHEMERAL
    else:
        configured_secret_key.SECRET_KEY_IS_EPHEMERAL = flag
    with pytest.raises(ImproperlyConfigured, match="SECRET_KEY"):
        issue_recovery_codes(user)
    with pytest.raises(ImproperlyConfigured, match="SECRET_KEY"):
        consume_recovery_code(user, codes[0])
    # Nothing was replaced or spent by the refused calls.
    assert RecoveryCode.objects.filter(creator=user, used_at__isnull=True).count() == 10


def _settings_flag(env_secret):
    env = {k: v for k, v in os.environ.items() if k != "SECRET_KEY"}
    if env_secret is not None:
        env["SECRET_KEY"] = env_secret
    py_root = Path(__file__).resolve().parents[4]
    out = subprocess.run(
        [sys.executable, "-c",
         "import dj.free2z.settings as s; print(s.SECRET_KEY_IS_EPHEMERAL)"],
        cwd=py_root, env=env, capture_output=True, text=True, timeout=120,
    )
    assert out.returncode == 0, out.stderr[-2000:]
    return out.stdout.strip().splitlines()[-1]


def test_settings_flag_the_random_fallback_and_only_it():
    assert _settings_flag(None) == "True"
    assert _settings_flag("") == "True"
    assert _settings_flag("a-configured-key-" + "z" * 40) == "False"


# --------------------------------------------------------------------------- #
# Single use under concurrency: two sessions, one code
# --------------------------------------------------------------------------- #
def _naive_consume(creator, code):
    """The read-then-write shape. Exists only as the negative control."""
    normalized = normalize_code(code)
    row = RecoveryCode.objects.filter(
        creator_id=creator.pk,
        digest=code_digest(creator.pk, normalized),
        used_at__isnull=True,
    ).first()
    if row is None:
        return False
    row.used_at = timezone.now()
    row.save(update_fields=["used_at"])
    return True


def _lock_waiters(exclude_pids) -> int:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT count(*) FROM pg_stat_activity "
            "WHERE datname = current_database() AND wait_event_type = 'Lock' "
            "AND pid <> ALL(%s)",
            [list(exclude_pids)],
        )
        return cursor.fetchone()[0]


def _race(consume, creator, code):
    """Session A spends and holds its transaction open; session B then
    tries the same code. A commits only once Postgres shows B waiting on a
    lock (or, for a shape that never blocks, once B has returned).

    Returns ``(a_result, b_result, b_blocked)``; ``b_blocked`` says Postgres
    reported B waiting on a lock while A held its transaction open.
    """
    results = {}
    errors = []
    a_spent = threading.Event()
    release_a = threading.Event()
    b_done = threading.Event()

    def session_a():
        try:
            with transaction.atomic():
                results["a"] = consume(creator, code)
                a_spent.set()
                assert release_a.wait(10), "A was never released"
        except BaseException as exc:  # pragma: no cover - surfaced below
            errors.append(exc)
            a_spent.set()
        finally:
            connections.close_all()

    def session_b():
        try:
            assert a_spent.wait(10)
            with transaction.atomic():
                results["b"] = consume(creator, code)
        except BaseException as exc:  # pragma: no cover - surfaced below
            errors.append(exc)
        finally:
            b_done.set()
            connections.close_all()

    ta = threading.Thread(target=session_a)
    tb = threading.Thread(target=session_b)
    ta.start()
    assert a_spent.wait(10)
    tb.start()
    my_pid = connection.cursor().connection.info.backend_pid
    deadline = time.monotonic() + 10
    blocked = False
    while time.monotonic() < deadline:
        if _lock_waiters({my_pid}) >= 1:
            blocked = True
            break
        if b_done.is_set():
            break
        time.sleep(0.02)
    else:  # pragma: no cover
        release_a.set()
        pytest.fail("session B neither blocked nor finished")
    release_a.set()
    ta.join(10)
    tb.join(10)
    close_old_connections()
    if errors:
        raise errors[0]
    return results["a"], results["b"], blocked


@pytest.mark.django_db(transaction=True)
def test_two_sessions_cannot_both_spend_one_code(creator_factory):
    user = _fresh(creator_factory())
    code = issue_recovery_codes(user)[0]

    a, b, b_blocked = _race(consume_recovery_code, user, code)

    # B really ran while A's spend was uncommitted: it queued on A's lock.
    assert b_blocked
    assert (a, b) == (True, False)
    assert RecoveryCode.objects.filter(creator=user, used_at__isnull=False).count() == 1


@pytest.mark.django_db(transaction=True)
def test_negative_control_the_read_then_write_shape_double_spends(creator_factory):
    """Proves the harness above can see a double spend: the same race, run
    against a find-then-mark implementation, lets both sessions succeed.
    If this ever goes green the other way, the harness has stopped forcing
    the interleaving and the real test proves nothing.
    """
    user = _fresh(creator_factory())
    code = issue_recovery_codes(user)[0]

    a, b, b_blocked = _race(_naive_consume, user, code)

    assert b_blocked
    assert (a, b) == (True, True)


@pytest.mark.django_db(transaction=True)
def test_concurrent_reissues_leave_exactly_one_set(creator_factory):
    user = _fresh(creator_factory())
    barrier = threading.Barrier(2)
    errors = []

    def reissue():
        try:
            barrier.wait(5)
            issue_recovery_codes(user)
        except BaseException as exc:  # pragma: no cover
            errors.append(exc)
        finally:
            connections.close_all()

    threads = [threading.Thread(target=reissue) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert not errors
    assert RecoveryCode.objects.filter(creator=user).count() == recovery.RECOVERY_CODE_COUNT
