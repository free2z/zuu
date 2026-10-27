"""An ownership event ends the evicted party's live bearer credentials.

``bump_account_epoch`` used to move the counter and nothing else. That left the
very sequence the counter exists to defeat running to completion one step
behind: an attacker holding a live Knox token survived the owner's
password reset, walked back up to ``/api/kt/handle-assertion/``, and was handed
a fresh assertion at the NEW epoch. Invalidating the old assertion while
leaving its holder able to request another is not revocation.

So every event that increments now also deletes the account's Knox tokens and
queues cleanup for the account's Django sessions. These tests pin both halves
of that:

* the endpoint refuses a token that was valid one request earlier — the attack
  above, end to end, through the real route;
* EVERY entry of ``OWNERSHIP_EVENTS`` revokes both credential surfaces —
  because that enumeration is the security property, and an event added to it
  tomorrow inherits revocation only for as long as:func:`bump_account_epoch`
  does the revoking rather than a per-call-site list;
* a refused event (a typo at a call site) revokes nothing, so the loud
  ``ValueError`` stays loud instead of silently taking the session with it.

The all-not-current decision — no session is exempted — is documented in
``epoch.py``'s docstring; these tests assert its consequence without
restating the argument.

the session half runs outside the caller's request thread: finding
an account's sessions means decoding every unexpired row on the platform, and
doing that under the Creator row lock was a DoS lever. The cleanup is now a
durable Procrastinate job inserted in the ownership transaction; tests that
assert a session died therefore run the task explicitly, as a worker would.
The epoch/session-auth-hash check is the immediate revocation path while the
job waits.
"""

import time

import pytest
from django.contrib.sessions.backends.db import SessionStore
from django.contrib.sessions.models import Session
from django.utils import timezone
from datetime import timedelta
from knox.models import AuthToken
from rest_framework.test import APIClient

from dj.apps.g12f.models import Creator
from dj.apps.ktauth import epoch
from dj.apps.ktauth.tasks import sweep_sessions

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def _empty_throttle_bucket():
    """The endpoint allows 10/hour per account; tests must not inherit a bucket."""
    from django.core.cache import cache

    cache.clear()
    yield
    cache.clear()


def minted_token(user) -> str:
    """A real Knox bearer token for ``user``, as a client would hold it."""
    _instance, raw_token = AuthToken.objects.create(user)
    return raw_token


def live_session_key(user) -> str:
    """A real db-backend session row authenticating ``user``."""
    store = SessionStore()
    store["_auth_user_id"] = str(user.pk)
    store.create()
    return store.session_key


def session_still_authenticates(key) -> bool:
    """Use-time truth, which is the only kind that matters here.

    The sweep retires a session by emptying its payload and leaving the row
    for ``clearsessions`` rather than deleting it (and see
    ``epoch._retire_matching`` for why), so the row outlives the event while
    authenticating nobody. ``SessionStore.exists()`` looks only for a row and
    would therefore answer a question nobody asked; ``load()`` is what every
    request does, and it is the one that says whether anyone is still signed
    in.
    """
    return SessionStore(session_key=key).load() != {}


def sweep_all_sessions(user_id, using) -> int:
    """Synchronous full-scan helper; queued workers use one page directly."""
    retired = 0
    after_key = ""
    while after_key is not None:
        count, after_key = epoch._sweep_sessions_page(user_id, using, after_key=after_key)
        retired += count
    return retired


def run_session_sweep(user):
    """Run a persisted queued task body as a worker would in these tests."""
    from procrastinate.contrib.django.models import ProcrastinateJob

    job = (
        ProcrastinateJob.objects.filter(
            task_name="ktauth.sweep_sessions",
            status="todo",
            args__user_id=user.pk,
        )
        .order_by("id")
        .first()
    )
    assert job is not None, f"no queued session sweep for user {user.pk}"
    ProcrastinateJob.objects.filter(pk=job.pk).update(status="doing")
    try:
        result = sweep_sessions(**job.args)
    except Exception:
        ProcrastinateJob.objects.filter(pk=job.pk).update(status="failed")
        raise
    ProcrastinateJob.objects.filter(pk=job.pk).update(status="succeeded")
    return result


# ------------------------------------------------------------- the  attack


def test_a_live_token_cannot_obtain_an_assertion_after_an_ownership_event(
    creator_factory, authority, kt_settings, url, identity_key_b64,
):
    """The failing-today test: the evicted holder cannot just ask again.

    The sequence is driven exactly as an attacker would drive it. A token is
    minted and used successfully; the owner performs an ownership event (the
    direct call stands in for any of its ~10 routes, every one of which calls
    this function); the SAME token is presented again. Before the fix the
    second POST succeeded — a fresh assertion at the new epoch. After it, the
    token row is gone, knox refuses the credential before the view runs at all.
    """
    user = creator_factory(username="alice")
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Token {minted_token(user)}")

    first = client.post(
        url,
        {"identity_key": identity_key_b64, "intent": "reset"},
        format="json",
    )
    assert first.status_code == 200, first.data

    epoch.bump_account_epoch(user.pk, event=epoch.EVENT_PASSWORD_RESET)

    second = client.post(
        url,
        {"identity_key": identity_key_b64, "intent": "reset"},
        format="json",
    )
    # Knox raises AuthenticationFailed without a WWW-Authenticate header, so
    # DRF renders it as 403 rather than 401; either way the view never runs
    # (same convention as test_endpoint.py's rejected-credential assertions).
    assert second.status_code in (401, 403), second.data


# ------------------------------------------- every declared event revokes both surfaces


@pytest.mark.parametrize("event", sorted(epoch.OWNERSHIP_EVENTS))
def test_every_ownership_event_revokes_tokens_and_sessions(
    event, creator_factory, django_capture_on_commit_callbacks,
):
    """Each entry of the list revokes BOTH surfaces, not just the counter.

    Parametrized over ``OWNERSHIP_EVENTS`` itself rather than over a copy, so
    an event added to the enumeration is covered the moment it exists — and an
    event whose bump stops revoking fails here even though the increment still
    works.
    """
    user = creator_factory()
    minted_token(user)
    key = live_session_key(user)
    assert AuthToken.objects.filter(user_id=user.pk).count() == 1

    with django_capture_on_commit_callbacks(execute=True):
        epoch.bump_account_epoch(user.pk, event=event)
    run_session_sweep(user)

    assert AuthToken.objects.filter(user_id=user.pk).count() == 0
    assert not session_still_authenticates(key)


def test_the_revocation_is_scoped_to_the_account_that_changed(
    creator_factory, django_capture_on_commit_callbacks,
):
    """Bumping Alice must not touch Bob — the over-broad control.

    Every other test here asserts that the victim's credentials die. None of
    them would notice a filter dropped or a comparison inverted, which would
    sign out EVERY account on the platform at every ownership event. So: two
    accounts, each holding one token and one live session, an event for Alice,
    and Bob's credentials are asserted alive afterwards.
    """
    alice = creator_factory(username="alice")
    bob = creator_factory(username="bob")
    minted_token(alice)
    minted_token(bob)
    bob_session_key = live_session_key(bob)

    with django_capture_on_commit_callbacks(execute=True):
        epoch.bump_account_epoch(alice.pk, event=epoch.EVENT_PASSWORD_CHANGE)
    run_session_sweep(alice)

    assert AuthToken.objects.filter(user_id=bob.pk).count() == 1
    store = SessionStore(session_key=bob_session_key)
    assert store.load().get("_auth_user_id") == str(bob.pk)


def test_the_log_line_counts_tokens_not_cascaded_rows(creator_factory, caplog):
    """The count in the log line is what an operator reads after an incident.

    ``_revoke_bearer_credentials`` reads the per-model entry of
    ``QuerySet.delete()``: every ``AuthToken`` cascades to its
    ``g12f.IssuedTokenEpoch`` stamp, so the raw total would report
    four for two tokens. Two tokens must read as two.
    """
    import logging

    user = creator_factory()
    minted_token(user)
    minted_token(user)

    with caplog.at_level(logging.INFO, logger="dj.apps.ktauth.epoch"):
        epoch.bump_account_epoch(user.pk, event=epoch.EVENT_PASSWORD_CHANGE)

    incremented = [
        record.getMessage()
        for record in caplog.records
        if "account_epoch incremented" in record.getMessage()
    ]
    assert incremented, caplog.records
    assert "2 bearer token(s)" in incremented[0], incremented[0]


def test_an_undecodable_session_row_is_skipped_not_fatal(
    creator_factory, django_capture_on_commit_callbacks,
):
    """A corrupt payload in the table must not turn a password change into a 500.

    The scan decodes rows to find the account's own; a row that refuses to
    decode belongs to nobody, is left alone, and costs nothing but a log line.
    """
    from django.contrib.sessions.models import Session

    user = creator_factory()
    minted_token(user)
    key = live_session_key(user)

    garbage = Session(
        session_key="x" * 40,
        session_data="not-a-session",
        expire_date=timezone.now() + timedelta(days=1),
    )
    garbage.save()

    with django_capture_on_commit_callbacks(execute=True):
        epoch.bump_account_epoch(user.pk, event=epoch.EVENT_PASSWORD_RESET)
    run_session_sweep(user)

    assert Session.objects.filter(pk=garbage.pk).exists()
    assert not session_still_authenticates(key)
    assert AuthToken.objects.filter(user_id=user.pk).count() == 0


def test_expired_session_rows_are_not_counted_as_revoked(creator_factory):
    """Only sessions that could still authenticate anyone count as revoked.

    An expired row authenticates nobody; claiming it in the log line would
    overstate what the event did. The user's real session dies all the same.
    """
    from django.contrib.sessions.models import Session

    user = creator_factory()
    key = live_session_key(user)
    dead = live_session_key(user)
    Session.objects.filter(session_key=dead).update(
        expire_date=timezone.now() - timedelta(seconds=1)
    )

    sessions_revoked = sweep_all_sessions(user.pk, using=None)

    assert sessions_revoked == 1
    assert not session_still_authenticates(key)


def test_a_refused_event_revokes_nothing(creator_factory):
    """The typo path must not take the credentials down with it.

    An undeclared event raises before anything is written, which is the whole
    design of the ``OWNERSHIP_EVENTS`` gate: loud, and side-effect free.
    """
    user = creator_factory()
    minted_token(user)
    key = live_session_key(user)

    with pytest.raises(ValueError, match="ownership event"):
        epoch.bump_account_epoch(user.pk, event="whatever")

    assert AuthToken.objects.filter(user_id=user.pk).count() == 1
    assert session_still_authenticates(key)


def test_revoking_an_account_with_no_live_credentials_is_harmless(
    creator_factory,
):
    """Most accounts hold neither surface when an event lands.

    Every pre-existing caller of ``bump_account_epoch`` ran against users with
    no tokens in the test suite; deleting zero rows must stay a no-op and not
    turn a routine credential change into a 500.
    """
    user = creator_factory()

    epoch.bump_account_epoch(user.pk, event=epoch.EVENT_ADMIN_CREDENTIAL_EDIT)
    epoch.bump_account_epoch(user.pk, event=epoch.EVENT_ADMIN_CREDENTIAL_EDIT)

    refreshed = Creator.objects.get(pk=user.pk)
    assert refreshed.kt_account_epoch == (
        epoch.INITIAL_ACCOUNT_EPOCH + 2
    )


# ------------------------------------------------------- the browser's session


def test_an_ownership_event_kills_the_browser_session(
    creator_factory, django_capture_on_commit_callbacks,
):
    """Knox is not the only surface: the cookie goes too.

    Signed in through the ordinary session backend, then an ownership event:
    the row behind the cookie is gone, so the next request re-authenticates
    nobody. This is the half a knox-only fix would have missed.

    Scope note: this is a UNIT test of `bump_account_epoch`'s session sweep,
    driven by a password-change event directly. The real password-change flow
    would ALSO have invalidated the session via Django's session-auth-hash
    comparison on next use — this function's sweep is what removes the row
    and covers it for every other event in the list.
    """
    user = creator_factory()
    client = APIClient()
    client.force_login(user)
    key = client.session.session_key

    with django_capture_on_commit_callbacks(execute=True):
        epoch.bump_account_epoch(user.pk, event=epoch.EVENT_PASSWORD_CHANGE)
    run_session_sweep(user)

    store = SessionStore(session_key=key)
    assert store.load() == {}


# ---------------------------------------- the sweep leaves the lock


def _session_queries(captured):
    return [q["sql"] for q in captured.captured_queries if "django_session" in q["sql"]]


def _assert_no_request_thread_session_sweep(calls, captured):
    assert calls == [], "the request ran the session sweep before worker action"
    assert _session_queries(captured) == [], (
        "the request scanned django_session across the commit boundary"
    )


@pytest.mark.django_db(transaction=True)
def test_the_session_sweep_runs_after_commit_not_under_the_account_lock(
    creator_factory, monkeypatch,
):
    """The durable job is inserted under the lock, but the scan is not.

    The shape mirrors ``AddEmailView``: ``SELECT... FOR UPDATE`` on the
    Creator, the credential change, the bump, all in one ``atomic()``. The
    queued row is visible inside that transaction. Capturing the whole block,
    including Django's commit hooks, proves the request performs no
    ``django_session`` scan before an explicit worker action. The worker then
    receives the serialized arguments from the persisted job row.
    """
    from django.db import connection, transaction
    from django.test.utils import CaptureQueriesContext

    user = creator_factory()
    key = live_session_key(user)
    sweep_calls = []
    real_sweep = epoch._sweep_sessions_page

    def observe_sweep(*args, **kwargs):
        sweep_calls.append((args, kwargs))
        return real_sweep(*args, **kwargs)

    monkeypatch.setattr(epoch, "_sweep_sessions_page", observe_sweep)

    with CaptureQueriesContext(connection) as captured:
        with transaction.atomic():
            Creator.objects.select_for_update().get(pk=user.pk)
            epoch.bump_account_epoch(user.pk, event=epoch.EVENT_RECOVERY_ADDRESS_CHANGE)
        _assert_no_request_thread_session_sweep(sweep_calls, captured)

    from procrastinate.contrib.django.models import ProcrastinateJob

    job = ProcrastinateJob.objects.get(
        task_name="ktauth.sweep_sessions",
        args__user_id=user.pk,
        status="todo",
    )
    assert job.args == {"user_id": user.pk, "using": "default",
                        "generation": epoch.INITIAL_ACCOUNT_EPOCH + 1, "after_key": ""}
    assert sweep_calls == []
    run_session_sweep(user)
    assert len(sweep_calls) == 1
    assert not session_still_authenticates(key)


@pytest.mark.django_db(transaction=True)
def test_transaction_boundary_control_catches_a_restored_on_commit_sweep(
    creator_factory, monkeypatch,
):
    """The boundary assertion fails if synchronous cleanup is restored.

    This is an intentional negative control for the regression above. The
    monkeypatch restores the old shape, where the full scan is an
    ``on_commit`` callback; the same whole-boundary assertion must then fail,
    and the fixture restores the real scheduler afterward.
    """
    from django.db import connection, transaction
    from django.test.utils import CaptureQueriesContext

    user = creator_factory()
    sweep_calls = []
    real_sweep = epoch._sweep_sessions_page

    def observe_sweep(*args, **kwargs):
        sweep_calls.append((args, kwargs))
        return real_sweep(*args, **kwargs)

    def restored_on_commit_schedule(user_id, using):
        transaction.on_commit(
            lambda: sweep_all_sessions(user_id, using),
            using=using or "default",
        )

    monkeypatch.setattr(epoch, "_sweep_sessions_page", observe_sweep)
    monkeypatch.setattr(epoch, "_schedule_session_sweep", restored_on_commit_schedule)

    with pytest.raises(AssertionError, match="request ran the session sweep"):
        with CaptureQueriesContext(connection) as captured:
            with transaction.atomic():
                Creator.objects.select_for_update().get(pk=user.pk)
                epoch.bump_account_epoch(
                    user.pk, event=epoch.EVENT_RECOVERY_ADDRESS_CHANGE
                )
            _assert_no_request_thread_session_sweep(sweep_calls, captured)


def test_a_login_that_lands_after_the_event_is_not_swept(
    creator_factory, django_capture_on_commit_callbacks,
):
    """A session created after the event is spared by the worker.

    Raised by the codex adversarial review of this branch. Between COMMIT
    and the moment the sweep opens its cursor, another worker can finish a
    login *with the new credential* — the owner signing back in on the
    device they just reset from, which is the ordinary case rather than an
    exotic one. ``_auth_user_id`` alone cannot tell that session from the
    evicted party's, so an unconditional sweep expires it and the owner is
    signed out one request after a successful login, with nothing anywhere
    saying why.

    The post-event auth hash is what spares it; the pre-event row alongside it
    must still die, or the test would pass for a sweep that spares everything.
    """
    user = creator_factory()
    stale = live_session_key(user)

    with django_capture_on_commit_callbacks(execute=True):
        epoch.bump_account_epoch(user.pk, event=epoch.EVENT_PASSWORD_RESET)

    #...the concurrent login, after the change committed and before the
    # sweep reads anything.
    user.refresh_from_db()
    fresh = SessionStore()
    fresh["_auth_user_id"] = str(user.pk)
    fresh["_auth_user_hash"] = user.get_session_auth_hash()
    fresh.create()

    run_session_sweep(user)

    assert not session_still_authenticates(stale)
    assert session_still_authenticates(fresh.session_key)


def test_the_expiry_is_conditional_on_the_payload_the_scan_read(creator_factory):
    """The write must not be a blind ``UPDATE... WHERE key IN (...)``.

    Also from the codex adversarial review. The sweep classifies a row from
    a cursor and writes it later; in that gap the row's owner can rewrite
    it — two ownership events overlapping on one account is enough, sweep A can read the payload of the row request B's ``cycle_key`` has
    since replaced with the current hash and a fresh expiry. A key-only
    write would expire a session B already re-proved, B returns 200, and
    B's next request is signed out with nothing to explain it.

    Driven at the seam rather than by racing two threads: the row is
    rewritten between the payload the scan captured and the write that uses
    it, which is exactly the interleaving, and is deterministic.
    """
    user = creator_factory()
    key = live_session_key(user)
    payload_the_scan_read = Session.objects.get(session_key=key).session_data

    refreshed = SessionStore(session_key=key)
    refreshed["_auth_user_id"] = str(user.pk)
    refreshed["_auth_user_hash"] = user.get_session_auth_hash()
    refreshed.save()
    assert Session.objects.get(session_key=key).session_data != (
        payload_the_scan_read
    ), "the fixture did not actually move the row"

    written = epoch._retire_matching(
        Session.objects.all(),
        [(key, payload_the_scan_read)],
        SessionStore().encode({}),
        timezone.now() + timedelta(seconds=60),
    )

    assert written == 0
    assert session_still_authenticates(key)


def test_the_socket_disconnect_callback_does_not_wait_for_the_session_worker(
    creator_factory, django_capture_on_commit_callbacks, monkeypatch,
):
    """The request callback does not wait for the session worker.

    The socket disconnect is the only post-commit callback. The O(all
    sessions) sweep is a worker job, so a slow or killed worker cannot delay
    the callback in this request. Once the commit is visible, the callback
    and worker are independent; this test's explicit worker call is not a
    claim about their global execution order.
    """
    order = []
    monkeypatch.setattr(
        epoch, "_sweep_sessions_page", lambda *a, **k: (order.append("sweep") or 0, None),
    )
    monkeypatch.setattr(
        "dj.apps.events.revocation.disconnect_live_sockets",
        lambda *a, **k: order.append("disconnect"),
    )
    user = creator_factory()

    with django_capture_on_commit_callbacks(execute=True):
        epoch.bump_account_epoch(user.pk, event=epoch.EVENT_PASSWORD_RESET)
    run_session_sweep(user)

    assert order == ["disconnect", "sweep"], order


def test_the_reaper_cannot_take_a_swept_row_in_the_response_window(
    creator_factory,
):
    """A swept row must outlive `clearsessions` running right behind it.

    Third finding of the codex adversarial review, and the reason the expiry
    goes into the FUTURE. The caller's own re-logged-in row is
    indistinguishable from a stale one when the sweep runs (it still carries
    the pre-event hash), so it IS swept -- and `SessionMiddleware` has not
    saved it yet, because that middleware runs outside the request
    transaction, after these callbacks. Stamp the expiry into the past and
    the daily `clearsessions` job becomes able to delete that row in exactly
    that window; the middleware's `force_update` then raises
    `SessionInterrupted` and a successful password change returns 400. Which
    is the failure the whole expire-rather-than-delete design exists to
    avoid, reintroduced at lower probability.

    So: run the reaper immediately after the sweep, with the real management
    command, and the row must still be there -- and must already
    authenticate nobody, or "survives the reaper" would be satisfied by not
    sweeping at all.
    """
    from django.core.management import call_command

    user = creator_factory()
    key = live_session_key(user)

    sweep_all_sessions(user.pk, using=None)
    call_command("clearsessions")

    assert Session.objects.filter(session_key=key).exists(), (
        "clearsessions collected the row while its request may still be "
        "holding it"
    )
    assert not session_still_authenticates(key)


def test_the_scan_holds_no_server_side_cursor(creator_factory, monkeypatch):
    """`.iterator()` is not streaming here, and that is the trap.

    Fifth codex adversarial round. Django's Postgres backend opens a chunked
    cursor with `withhold=connection.autocommit`, and this sweep now runs in
    the worker -- normally in autocommit -- so `.iterator()` declares a WITH
    HOLD cursor. Postgres materialises such a cursor's ENTIRE result at
    commit, to memory and then to temporary files, and holds it for the
    cursor's life. `chunk_size` bounds what the client fetches and nothing
    else, and this sweep reads every unexpired row on the platform, so the
    allocation lands on the shared production database and is paid by
    unrelated queries. The call
    reads as bounded, which is exactly why it survived review until a
    different model looked at it.

    Pinned structurally, because the failure has no functional symptom in a
    test-sized table: the scan must issue bounded, ordered page queries and
    must never DECLARE a cursor.
    """
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    user = creator_factory()
    for _ in range(3):
        live_session_key(user)
    monkeypatch.setattr(epoch, "SESSION_SWEEP_FETCH_CHUNK", 1)

    with CaptureQueriesContext(connection) as captured:
        assert sweep_all_sessions(user.pk, using=None) == 3

    sqls = [q["sql"] for q in captured.captured_queries]
    assert not [sql for sql in sqls if sql.lstrip().upper().startswith("DECLARE")], (
        sqls
    )
    pages = [
        sql for sql in sqls
        if "django_session" in sql and " LIMIT " in sql.upper()
    ]
    # Three rows at one row per page, plus the page that comes back empty.
    assert len(pages) >= 4, sqls
    assert all("ORDER BY" in sql.upper() for sql in pages), pages


def test_the_sweep_is_complete_across_page_and_batch_boundaries(
    creator_factory, monkeypatch,
):
    """Every owner row, and only owner rows, across many pages AND batches.

    Adversarial review of, as a coverage gap rather than a defect: the
    other sweep tests use single-digit tables, so ``SESSION_SWEEP_FETCH_CHUNK``
    (2000) is never crossed and ``SESSION_SWEEP_EXPIRE_BATCH`` (200) never
    fills more than once. The two paging schemes in ``_sweep_sessions`` are
    independent and interleaved -- the scan advances by
    ``pk__gt=after_key`` over a page, the writer flushes whenever ``doomed``
    reaches the batch size -- so the bugs they can have are boundary bugs:
    a row lost at ``after_key`` (``pk__gte``/``pk__gt`` confusion), a partial
    final batch never flushed, an owner row skipped because a page boundary
    fell inside it.

    Driven with deliberately NON-DIVISIBLE sizes so no boundary lines up with
    another: 25 owner sessions interleaved with 25 belonging to someone else,
    a 4-row fetch page and a 3-row expire batch -- 13 pages and 9 batches,
    with the last of each partial. The assertion is completeness, which is
    what a boundary bug breaks and what a small table cannot show.

    Wall clock is deliberately NOT asserted here.  asks for a bound on a
    realistic table, and a table big enough to time is not a unit test; that
    measurement belongs in the PR body (100,000 noise rows + 500 owner
    sessions retire in ~1.3s in the worker, ~75k rows/s, and the
    200-branch ``Q(pk, session_data)`` OR plans as a BitmapOr over the PK
    index at 0.35ms rather than a seq scan). The LOCK-hold bound, which is
    the half that actually caused, is pinned by
    ``test_the_session_sweep_runs_after_commit_not_under_the_account_lock``.
    """
    owner = creator_factory()
    other = creator_factory()
    owner_keys = []
    other_keys = []
    # Interleaved, so the two accounts' rows are mixed across pages rather
    # than sitting in two contiguous runs. Session keys are random, so the
    # primary-key order the scan walks is unrelated to creation order
    # anyway -- interleaving just makes that explicit.
    for _ in range(25):
        owner_keys.append(live_session_key(owner))
        other_keys.append(live_session_key(other))

    monkeypatch.setattr(epoch, "SESSION_SWEEP_FETCH_CHUNK", 4)
    monkeypatch.setattr(epoch, "SESSION_SWEEP_EXPIRE_BATCH", 3)

    assert sweep_all_sessions(owner.pk, using=None) == 25

    assert not [key for key in owner_keys if session_still_authenticates(key)], (
        "the sweep lost owner rows at a page or batch boundary"
    )
    assert all(session_still_authenticates(key) for key in other_keys), (
        "the sweep retired another account's sessions"
    )


def test_the_reaper_grace_is_measured_from_each_write_not_the_sweep_start(
    creator_factory, monkeypatch,
):
    """A grace stamped once at the top of the sweep can already have elapsed.

    Fourth codex adversarial round. The worker may start while the request that
    created a session is finishing, and the scan is O(every unexpired row on
    the platform). A single ``expires_at`` computed before
    the cursor opens is therefore a promise about a duration nothing bounds:
    on a slow or large table the first batch's rows are already collectable
    long before ``SessionMiddleware.process_response`` runs, which is the
    exact 400 this design exists to prevent.

    Driven with a one-row batch and a deliberate pause after each write, so
    the second batch lands measurably later than the first. Under a
    stamped-once expiry the two rows carry the SAME ``expire_date``.
    """
    user = creator_factory()
    first = live_session_key(user)
    second = live_session_key(user)
    monkeypatch.setattr(epoch, "SESSION_SWEEP_EXPIRE_BATCH", 1)

    real_retire = epoch._retire_matching

    def slow_retire(*args, **kwargs):
        written = real_retire(*args, **kwargs)
        time.sleep(0.05)
        return written

    monkeypatch.setattr(epoch, "_retire_matching", slow_retire)

    assert sweep_all_sessions(user.pk, using=None) == 2

    expiries = sorted(
        Session.objects.filter(session_key__in=[first, second]).values_list(
            "expire_date", flat=True
        )
    )
    assert expiries[1] - expiries[0] >= timedelta(seconds=0.04), expiries


def test_the_reaper_grace_outlasts_the_request_that_needs_it(creator_factory):
    """And the grace has to be sized against something real.

    The only thing that bounds "how long until the response saves the
    session" is the worker timeout: a request that dies there never reaches
    ``process_response``, so there is no save left to protect. The grace must
    therefore exceed that timeout rather than a guess about scan speed — the
    first cut was 60 seconds against an unbounded scan, which is what the
    review caught.
    """
    worker_timeout_seconds = 600
    assert epoch.SESSION_SWEEP_REAP_GRACE_SECONDS > worker_timeout_seconds


def test_the_current_hash_is_read_after_the_session_scan_not_before(
    creator_factory,
):
    """The current-hash test must be taken at write time, not scan time.

    Second finding of the codex adversarial review. A sweep can be streaming
    for a long time -- it is O(every unexpired row on the platform) -- and a
    SECOND ownership event can commit inside that window. A login made
    against THAT newer credential is legitimate and newer than anything this
    sweep knows about, but a `live_hashes` snapshot taken before the cursor
    opened does not contain its hash, so the sweep retires it and the owner
    is signed out immediately after a successful login.

    Reading immediately before each write does not make the race impossible
    -- nothing short of a row lock would -- but it narrows it from the whole
    scan to the gap between two adjacent statements. That is a claim about
    ORDER, so order is what is pinned: the account read must come after the
    session scan. Under the snapshot version it comes first.
    """
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    user = creator_factory()
    live_session_key(user)
    creator_table = Creator._meta.db_table

    with CaptureQueriesContext(connection) as captured:
        assert sweep_all_sessions(user.pk, using=None) == 1

    sqls = [q["sql"] for q in captured.captured_queries]
    # The scan is `.iterator()`, so on Postgres it appears as a server-side
    # `DECLARE... CURSOR FOR SELECT`, not a bare SELECT. Match on "reads the
    # session table" instead of on the verb.
    scanned_at = next(
        i for i, sql in enumerate(sqls)
        if "django_session" in sql
        and not sql.lstrip().upper().startswith(("UPDATE", "DELETE"))
    )
    account_read_at = next(
        i for i, sql in enumerate(sqls)
        if creator_table in sql and sql.lstrip().upper().startswith("SELECT")
    )
    assert account_read_at > scanned_at, sqls


@pytest.mark.parametrize("using", [None, "default"])
def test_mismatched_queue_database_refuses_before_any_write(
    creator_factory, monkeypatch, using,
):
    from django.core.exceptions import ImproperlyConfigured
    from django.db import connection
    from django.test.utils import CaptureQueriesContext
    from procrastinate.contrib.django import app
    from procrastinate.contrib.django.models import ProcrastinateJob

    user = creator_factory()
    minted_token(user)
    key = live_session_key(user)
    initial_epoch = user.kt_account_epoch
    with monkeypatch.context() as mismatch:
        mismatch.setattr(app.connector, "alias", "different-database")
        # No outer transaction is rolled back to hide a premature epoch or
        # token mutation. The guard must run before the first database write.
        with CaptureQueriesContext(connection) as captured:
            with pytest.raises(ImproperlyConfigured, match="same database alias"):
                epoch.bump_account_epoch(
                    user.pk, event=epoch.EVENT_PASSWORD_CHANGE, using=using,
                )
        assert not captured.captured_queries

    user.refresh_from_db()
    assert user.kt_account_epoch == initial_epoch
    assert AuthToken.objects.filter(user=user).exists()
    assert session_still_authenticates(key)
    assert not ProcrastinateJob.objects.filter(
        task_name="ktauth.sweep_sessions", args__user_id=user.pk,
    ).exists()


@pytest.mark.django_db(transaction=True)
def test_a_rolled_back_ownership_event_sweeps_no_session(creator_factory):
    """Rollback removes both the epoch change and its durable cleanup job."""
    from django.db import transaction
    from procrastinate.contrib.django.models import ProcrastinateJob

    user = creator_factory()
    key = live_session_key(user)

    with pytest.raises(RuntimeError):
        with transaction.atomic():
            epoch.bump_account_epoch(user.pk, event=epoch.EVENT_PASSWORD_CHANGE)
            raise RuntimeError("something later in the request failed")

    assert session_still_authenticates(key)
    assert Creator.objects.get(pk=user.pk).kt_account_epoch == (
        epoch.INITIAL_ACCOUNT_EPOCH
    )
    assert not ProcrastinateJob.objects.filter(
        task_name="ktauth.sweep_sessions",
        args__user_id=user.pk,
    ).exists()


@pytest.mark.django_db(transaction=True)
def test_pending_session_sweeps_keep_a_full_scan_for_each_epoch(
    creator_factory,
):
    """A later epoch gets its own cursor; stale work stops before scanning."""
    from django.db import transaction
    from procrastinate.contrib.django.models import ProcrastinateJob

    user = creator_factory()
    key = live_session_key(user)

    with transaction.atomic():
        epoch.bump_account_epoch(user.pk, event=epoch.EVENT_PASSWORD_RESET)
        epoch.bump_account_epoch(user.pk, event=epoch.EVENT_PASSWORD_CHANGE)

    jobs = list(ProcrastinateJob.objects.filter(
        task_name="ktauth.sweep_sessions",
        args__user_id=user.pk,
        status="todo",
    ))
    assert len(jobs) == 2
    assert all(job.queue_name == "default" for job in jobs)
    assert all(job.queueing_lock == f"{job.lock}-page-start" for job in jobs)
    assert len({job.queueing_lock for job in jobs}) == 2
    assert run_session_sweep(user) == 0  # obsolete epoch yields immediately
    run_session_sweep(user)
    assert not session_still_authenticates(key)


@pytest.mark.django_db(transaction=True)
def test_event_during_running_session_sweep_enqueues_a_follow_up_job(
    creator_factory,
):
    """A running job does not make a later ownership event disappear."""
    from django.db import transaction
    from procrastinate.contrib.django.models import ProcrastinateJob

    user = creator_factory()
    key = live_session_key(user)

    with transaction.atomic():
        epoch.bump_account_epoch(user.pk, event=epoch.EVENT_PASSWORD_RESET)

    first = ProcrastinateJob.objects.get(
        task_name="ktauth.sweep_sessions",
        args__user_id=user.pk,
        status="todo",
    )
    ProcrastinateJob.objects.filter(pk=first.pk).update(status="doing")

    with transaction.atomic():
        epoch.bump_account_epoch(user.pk, event=epoch.EVENT_PASSWORD_CHANGE)

    jobs = list(
        ProcrastinateJob.objects.filter(
            task_name="ktauth.sweep_sessions",
            args__user_id=user.pk,
        ).order_by("id")
    )
    assert [job.status for job in jobs] == ["doing", "todo"]
    assert all(job.args["user_id"] == user.pk and job.args["using"] == "default"
               and job.args["after_key"] == "" for job in jobs)
    assert [job.args["generation"] for job in jobs] == [
        epoch.INITIAL_ACCOUNT_EPOCH + 1, epoch.INITIAL_ACCOUNT_EPOCH + 2,
    ]

    # The helper consumes the second job's persisted args, not a reconstructed
    # user id, so the follow-up also exercises task serialization and routing.
    ProcrastinateJob.objects.filter(pk=first.pk).update(status="succeeded")
    run_session_sweep(user)
    assert not session_still_authenticates(key)


@pytest.mark.django_db(transaction=True)
def test_the_real_password_change_keeps_the_callers_new_session_and_kills_the_rest(
    creator_factory,
):
    """Through the real route, with a real commit — the case that decided the
    mechanism, so it is worth stating what it caught.

    ``dj-rest-auth`` re-logs the caller in with ``update_session_auth_hash``
    *inside* the request transaction, and ``cycle_key()`` writes the new row
    from the session cache it is already holding — so the row on disk still
    carries the **pre-event** auth hash until response middleware saves it.
    Nothing the worker can read distinguishes it from the attacker's stale
    row, and a first cut that tried to (spare rows whose stored hash is
    current) therefore deleted it. ``SessionMiddleware.process_response``
    runs OUTSIDE the request transaction, and the worker may run before,
    during, or after that response save. A delete in that window would make
    its ``save()`` hit a missing row:

        django.contrib.sessions.exceptions.SessionInterrupted: The request's
        session was deleted before the request completed.

    a 400 handed to a user for successfully changing their password.
    Expiring rather than deleting, with the future grace, makes that same
    ``save()`` succeed and
    rewrite both the expiry and the new hash, which is the wanted outcome
    on both sides:

    * the caller keeps the session they just re-proved — 200, and their
      cookie still works;
    * the other device, signed in before the change, is dead at its next
      load, and its row is left in the state ``clearsessions`` collects.

    Checked at USE time on both cookies, which is the contract; the row
    assertion below is only about *how* the other device died.
    """
    from django.test import Client

    user = creator_factory(password="old-password-9x")
    other_device = Client()
    other_device.force_login(user)
    other_key = other_device.session.session_key
    caller = Client()
    assert caller.login(username=user.username, password="old-password-9x")

    response = caller.post(
        "/api/auth/password/change/",
        {
            "old_password": "old-password-9x",
            "new_password1": "new-password-7q!",
            "new_password2": "new-password-7q!",
        },
        content_type="application/json",
    )

    assert response.status_code == 200, response.content
    assert caller.get("/api/auth/user/").status_code == 200
    run_session_sweep(user)
    assert not session_still_authenticates(other_key)
    # Retired, not deleted: the row is still there, empty, and due to be
    # collected by `clearsessions` shortly rather than the moment the
    # caller's own response is still mid-flight.
    retired = Session.objects.get(session_key=other_key)
    assert SessionStore().decode(retired.session_data) == {}
    assert retired.expire_date < timezone.now() + timedelta(
        seconds=epoch.SESSION_SWEEP_REAP_GRACE_SECONDS + 5
    )
    assert other_device.get("/api/auth/user/").status_code in (401, 403)


@pytest.mark.django_db(transaction=True)
def test_a_sweep_job_failure_does_not_restore_access_or_tokens(
    creator_factory, caplog,
):
    """A failed async pass is retryable hygiene, not the revocation boundary."""
    import logging
    from unittest import mock

    user = creator_factory()
    minted_token(user)

    epoch.bump_account_epoch(user.pk, event=epoch.EVENT_PASSWORD_RESET)

    with caplog.at_level(logging.ERROR, logger="dj.apps.ktauth.tasks"):
        with mock.patch.object(
            epoch, "_sweep_sessions_page", side_effect=RuntimeError("db went away")
        ):
            with pytest.raises(RuntimeError, match="db went away"):
                run_session_sweep(user)

    assert not AuthToken.objects.filter(user_id=user.pk).exists()
    assert Creator.objects.get(pk=user.pk).kt_account_epoch == (
        epoch.INITIAL_ACCOUNT_EPOCH + 1
    )
    assert any(
        str(user.pk) in record.getMessage() and "stale rows remain" in record.getMessage()
        for record in caplog.records
    ), caplog.records


@pytest.mark.django_db(transaction=True)
def test_session_page_yields_to_existing_queue_work(creator_factory, monkeypatch):
    """The real PostgreSQL fetcher picks other queued work before continuation."""
    from django.db import connection
    from procrastinate.contrib.django.models import ProcrastinateJob
    from procrastinate.contrib.django import app

    # An earlier fixture job has no user_id JSON key. JSON-key exclusion does
    # not match missing keys, so it cannot isolate the scheduler in a full shard.
    app.tasks["jobs.report_job_health"].defer()
    user = creator_factory()
    keys = [live_session_key(user) for _ in range(5)]
    Session.objects.create(
        session_key="0" * 32, session_data="", expire_date=timezone.now() - timedelta(days=1),
    )
    monkeypatch.setattr(epoch, "SESSION_SWEEP_FETCH_CHUNK", 2)
    epoch.bump_account_epoch(user.pk, event=epoch.EVENT_PASSWORD_RESET)
    # Procrastinate's unmanaged tables survive Django's between-test flush.
    # Retire leftover fixture jobs so the production fetcher sees this queue.
    first_id = ProcrastinateJob.objects.filter(
        task_name="ktauth.sweep_sessions", args__user_id=user.pk,
    ).latest("id").pk
    ProcrastinateJob.objects.exclude(pk=first_id).update(status="succeeded")
    marker_id = app.tasks["jobs.report_job_health"].defer()
    # The expired key consumes a page slot too; skipping it in SQL could make
    # a sparse active page walk arbitrarily many expired records.
    assert run_session_sweep(user) == 1
    assert sum(session_still_authenticates(key) for key in keys) == 4
    continuation = ProcrastinateJob.objects.get(
        task_name="ktauth.sweep_sessions", status="todo", args__user_id=user.pk,
    )
    assert continuation.id > marker_id
    assert continuation.args["after_key"]
    with connection.cursor() as cursor:
        cursor.execute("SELECT procrastinate_register_worker_v1()")
        worker_id = cursor.fetchone()[0]
        cursor.execute(
            "SELECT id FROM procrastinate_fetch_job_v2(ARRAY['default']::varchar[], %s)",
            [worker_id],
        )
        assert cursor.fetchone()[0] == marker_id
    ProcrastinateJob.objects.filter(pk=marker_id).update(status="succeeded")
    while ProcrastinateJob.objects.filter(
        task_name="ktauth.sweep_sessions", status="todo", args__user_id=user.pk,
    ).exists():
        run_session_sweep(user)
    assert not any(session_still_authenticates(key) for key in keys)


@pytest.mark.django_db(transaction=True)
def test_new_epoch_restarts_before_an_old_continuation_cursor(creator_factory, monkeypatch):
    """A newly stale login before an old cursor must still be retired."""
    from procrastinate.contrib.django.models import ProcrastinateJob

    user = creator_factory()
    keys = sorted(live_session_key(user) for _ in range(3))
    monkeypatch.setattr(epoch, "SESSION_SWEEP_FETCH_CHUNK", 1)
    epoch.bump_account_epoch(user.pk, event=epoch.EVENT_PASSWORD_RESET)
    assert run_session_sweep(user) == 1
    # The legitimate owner signs in again on a key already passed by epoch A.
    user.refresh_from_db()
    fresh = SessionStore(session_key=keys[0])
    fresh["_auth_user_id"] = str(user.pk)
    fresh["_auth_user_hash"] = user.get_session_auth_hash()
    fresh.save()
    epoch.bump_account_epoch(user.pk, event=epoch.EVENT_PASSWORD_CHANGE)
    queued = list(ProcrastinateJob.objects.filter(
        task_name="ktauth.sweep_sessions", status="todo", args__user_id=user.pk,
    ).order_by("id"))
    assert [job.args["after_key"] for job in queued] == [keys[0], ""]
    assert queued[0].queueing_lock != queued[1].queueing_lock
    with monkeypatch.context() as no_scan:
        no_scan.setattr(epoch, "_sweep_sessions_page", lambda *a, **k: pytest.fail(
            "superseded epoch consumed a scan page"))
        assert run_session_sweep(user) == 0
    while ProcrastinateJob.objects.filter(
        task_name="ktauth.sweep_sessions", status="todo", args__user_id=user.pk,
    ).exists():
        run_session_sweep(user)
    assert not any(session_still_authenticates(key) for key in keys)


@pytest.mark.django_db(transaction=True)
def test_session_page_retry_restores_a_failed_continuation_enqueue(creator_factory, monkeypatch):
    """Retirement before enqueue failure is safe to replay without losing the tail."""
    from dj.apps.ktauth import tasks
    from procrastinate.contrib.django.models import ProcrastinateJob

    user = creator_factory()
    keys = sorted(live_session_key(user) for _ in range(3))
    monkeypatch.setattr(epoch, "SESSION_SWEEP_FETCH_CHUNK", 1)
    epoch.bump_account_epoch(user.pk, event=epoch.EVENT_PASSWORD_RESET)
    first = ProcrastinateJob.objects.get(task_name="ktauth.sweep_sessions", status="todo", args__user_id=user.pk)
    with monkeypatch.context() as broken:
        def fail_enqueue(*args, **kwargs):
            raise RuntimeError("enqueue unavailable")
        broken.setattr(tasks, "enqueue_session_sweep", fail_enqueue)
        with pytest.raises(RuntimeError, match="enqueue unavailable"):
            run_session_sweep(user)
    assert not session_still_authenticates(keys[0])
    assert all(session_still_authenticates(key) for key in keys[1:])
    # A worker retry receives the original persisted arguments.
    ProcrastinateJob.objects.filter(pk=first.pk).update(status="todo")
    while ProcrastinateJob.objects.filter(
        task_name="ktauth.sweep_sessions", status="todo", args__user_id=user.pk,
    ).exists():
        run_session_sweep(user)
    assert not any(session_still_authenticates(key) for key in keys)


@pytest.mark.django_db(transaction=True)
def test_abandoned_doing_epoch_does_not_block_later_cleanup(creator_factory):
    """The production fetcher can pass a killed worker's old-generation row."""
    from django.db import connection
    from procrastinate.contrib.django.models import ProcrastinateJob
    from procrastinate.contrib.django import app

    app.tasks["jobs.report_job_health"].defer()  # unrelated full-shard leftover
    user = creator_factory()
    key = live_session_key(user)
    epoch.bump_account_epoch(user.pk, event=epoch.EVENT_PASSWORD_RESET)
    abandoned = ProcrastinateJob.objects.get(
        task_name="ktauth.sweep_sessions", status="todo", args__user_id=user.pk,
    )
    ProcrastinateJob.objects.filter(pk=abandoned.pk).update(status="doing")
    epoch.bump_account_epoch(user.pk, event=epoch.EVENT_PASSWORD_CHANGE)
    replacement = ProcrastinateJob.objects.get(
        task_name="ktauth.sweep_sessions", status="todo", args__user_id=user.pk,
    )
    ProcrastinateJob.objects.exclude(
        pk__in=[abandoned.pk, replacement.pk],
    ).update(status="succeeded")
    with connection.cursor() as cursor:
        cursor.execute("SELECT procrastinate_register_worker_v1()")
        worker_id = cursor.fetchone()[0]
        cursor.execute(
            "SELECT id FROM procrastinate_fetch_job_v2(ARRAY['default']::varchar[], %s)",
            [worker_id],
        )
        assert cursor.fetchone()[0] == replacement.pk
    assert sweep_sessions(**replacement.args) == 1
    assert not session_still_authenticates(key)
    abandoned.refresh_from_db()
    assert abandoned.status == "doing"  # no fake recovery of the lost generation


@pytest.mark.django_db(transaction=True)
def test_live_epochs_overlap_without_retiring_a_new_login(creator_factory, monkeypatch):
    """Old page CAS resumes after a new epoch cleans up and preserves its login."""
    user = creator_factory()
    fresh_key, stale_key = [live_session_key(user) for _ in range(2)]
    epoch.bump_account_epoch(user.pk, event=epoch.EVENT_PASSWORD_RESET)
    real_retire = epoch._retire_matching
    interleaved = False

    def retire_after_new_epoch(*args, **kwargs):
        nonlocal interleaved
        if not interleaved:
            interleaved = True
            # Epoch A has already captured payloads and checked current hashes.
            # Epoch B commits and the legitimate owner signs in before A writes.
            epoch.bump_account_epoch(user.pk, event=epoch.EVENT_PASSWORD_CHANGE)
            user.refresh_from_db()
            fresh = SessionStore(session_key=fresh_key)
            fresh["_auth_user_id"] = str(user.pk)
            fresh["_auth_user_hash"] = user.get_session_auth_hash()
            fresh.save()
            # B really runs while A remains `doing`: different-generation locks
            # permit this, while current-hash checks spare the new login.
            assert run_session_sweep(user) == 1
        return real_retire(*args, **kwargs)

    monkeypatch.setattr(epoch, "_retire_matching", retire_after_new_epoch)
    assert run_session_sweep(user) == 0
    assert interleaved
    assert session_still_authenticates(fresh_key)
    assert not session_still_authenticates(stale_key)


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("shared_queueing_lock", [True, False])
def test_committed_continuation_allows_parent_retry(
    creator_factory, monkeypatch, shared_queueing_lock,
):
    """Real retry SQL catches the old parent/child queueing-lock collision."""
    from django.db import connection, IntegrityError, transaction
    from procrastinate.contrib.django.models import ProcrastinateJob
    from dj.apps.ktauth import tasks

    user = creator_factory()
    keys = sorted(live_session_key(user) for _ in range(3))
    monkeypatch.setattr(epoch, "SESSION_SWEEP_FETCH_CHUNK", 1)
    epoch.bump_account_epoch(user.pk, event=epoch.EVENT_PASSWORD_RESET)
    first = ProcrastinateJob.objects.get(
        task_name="ktauth.sweep_sessions", status="todo", args__user_id=user.pk,
    )
    ProcrastinateJob.objects.filter(pk=first.pk).update(status="doing")
    real_enqueue = tasks.enqueue_session_sweep

    def commit_then_lose_reply(*args, **kwargs):
        real_enqueue(*args, **kwargs)
        raise ConnectionError("commit reply lost")

    with monkeypatch.context() as lost_reply:
        lost_reply.setattr(tasks, "enqueue_session_sweep", commit_then_lose_reply)
        with pytest.raises(ConnectionError, match="commit reply lost"):
            sweep_sessions(**first.args)
    child = ProcrastinateJob.objects.get(
        task_name="ktauth.sweep_sessions", status="todo", args__user_id=user.pk,
    )
    assert child.args["after_key"] == keys[0]
    if shared_queueing_lock:
        # Negative control restores only the original shared queueing key.
        ProcrastinateJob.objects.filter(pk=child.pk).update(queueing_lock=first.queueing_lock)

    def real_retry():
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT procrastinate_retry_job_v2(%s, NULL, NULL, NULL, NULL)",
                [first.pk],
            )

    if shared_queueing_lock:
        with pytest.raises(IntegrityError):
            with transaction.atomic():
                real_retry()
        first.refresh_from_db()
        assert first.status == "doing"
        return

    real_retry()
    first.refresh_from_db()
    assert first.status == "todo" and first.attempts == 1
    assert run_session_sweep(user) == 0  # replay the already retired first page
    # Its retry coalesces with the child already committed, rather than
    # multiplying continuations or replacing the child's cursor.
    pending = list(ProcrastinateJob.objects.filter(
        task_name="ktauth.sweep_sessions", status="todo", args__user_id=user.pk,
    ))
    assert [job.pk for job in pending] == [child.pk]
    while ProcrastinateJob.objects.filter(
        task_name="ktauth.sweep_sessions", status="todo", args__user_id=user.pk,
    ).exists():
        run_session_sweep(user)
    assert not any(session_still_authenticates(key) for key in keys)
