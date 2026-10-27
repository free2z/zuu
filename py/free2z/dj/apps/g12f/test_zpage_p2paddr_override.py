"""The read shape tells an editor an override from an inherited address.

``p2paddr`` on a zPage read is the EFFECTIVE support address (the page's own,
else the creator's). An editor that round-trips it pins the creator's current
address onto every inheriting page it saves. ``p2paddr_override`` is the raw
page value -- ``None`` when the page inherits -- and is what an editor must
hydrate from. ``p2paddr`` keeps its meaning for every existing reader.
"""

import datetime
import io
import threading
import time
import uuid

import pytest
from django.core.management import call_command
from django.db import connection, transaction

from dj.apps.g12f.models import zPage

PROFILE_ADDR = (
    "u1fugcwe8xceuyvp7t8m3rpk22e0u8m3dyzdh9hdv40zsqpyvac7lxkx5t49nmp4p4w793"
    "ngh7fdc0zg7ws7w6gfdcx2rjthss0vhfdwrh"
)
PAGE_ADDR = (
    "zs12f4y80pjhy042rmxq339dr6885jqqvh9fc6j8pvxg3hyhc8hmsqurlkqtkzwp03quca27pt0f7k"
)


def _creator(creator_factory):
    creator = creator_factory()
    creator.p2paddr = PROFILE_ADDR
    creator.save(update_fields=["p2paddr"])
    return creator


def _page(creator, p2paddr=""):
    return zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        vanity=f"article-{uuid.uuid4()}",
        title="Supportable article",
        content="Article body",
        is_published=True,
        p2paddr=p2paddr,
    )


def _editor_put(api_client, page, detail, p2paddr):
    """The payload shape the new-UI editor sends on save."""
    return api_client.put(
        f"/api/zpage/{page.free2zaddr}/",
        {
            "title": detail["title"],
            "content": detail["content"],
            "description": "",
            "canonical_url": "",
            "tags": list(detail["tags"]),
            "vanity": detail["vanity"],
            "p2paddr": p2paddr,
            "is_published": True,
            "is_subscriber_only": False,
        },
        format="json",
    )


@pytest.mark.django_db
def test_inheriting_page_reads_effective_address_and_null_override(
    api_client, creator_factory
):
    creator = _creator(creator_factory)
    page = _page(creator)

    data = api_client.get(f"/api/zpage/{page.free2zaddr}/").data

    # Existing readers (ZUULI, classic, the support button) keep paying this.
    assert data["p2paddr"] == PROFILE_ADDR
    assert data["p2paddr_override"] is None


@pytest.mark.django_db
def test_overriding_page_reads_its_own_address_in_both_fields(
    api_client, creator_factory
):
    creator = _creator(creator_factory)
    page = _page(creator, PAGE_ADDR)

    data = api_client.get(f"/api/zpage/{page.free2zaddr}/").data

    assert data["p2paddr"] == PAGE_ADDR
    assert data["p2paddr_override"] == PAGE_ADDR


@pytest.mark.django_db
def test_a_page_pinned_to_the_profile_address_reports_the_pin(
    api_client, creator_factory
):
    """The ambiguous case the effective value hides: an explicit copy."""
    creator = _creator(creator_factory)
    page = _page(creator, PROFILE_ADDR)

    data = api_client.get(f"/api/zpage/{page.free2zaddr}/").data

    assert data["p2paddr"] == PROFILE_ADDR
    assert data["p2paddr_override"] == PROFILE_ADDR


@pytest.mark.django_db
def test_editor_round_trip_of_the_override_keeps_the_page_inheriting(
    api_client, creator_factory
):
    """Open, save, rotate the profile address: support follows the profile."""
    creator = _creator(creator_factory)
    page = _page(creator)
    api_client.force_authenticate(user=creator)

    detail = api_client.get(f"/api/zpage/{page.free2zaddr}/").data
    response = _editor_put(
        api_client, page, detail, detail["p2paddr_override"] or "",
    )

    assert response.status_code == 200, response.data
    # The write answers with the read representation, override included.
    assert response.data["p2paddr_override"] is None
    page.refresh_from_db()
    assert page.p2paddr == ""

    creator.p2paddr = PAGE_ADDR
    creator.save(update_fields=["p2paddr"])
    api_client.force_authenticate(user=None)
    after = api_client.get(f"/api/zpage/{page.free2zaddr}/").data
    assert after["p2paddr"] == PAGE_ADDR


@pytest.mark.django_db
def test_variant_read_carries_the_canonical_override(api_client, creator_factory):
    creator = _creator(creator_factory)
    page = _page(creator)
    api_client.force_authenticate(user=creator)

    data = api_client.get(f"/api/zpage/{page.free2zaddr}/?lang=fr&mine=true").data

    assert data["p2paddr_override"] is None


# --- unpin_inherited_p2paddr ------------------------------------------------


def _set_updated(page, when):
    zPage.objects.filter(pk=page.pk).update(updated_at=when)


def _run(*args):
    out = io.StringIO()
    call_command("unpin_inherited_p2paddr", *args, stdout=out)
    return out.getvalue()


@pytest.mark.django_db
def test_unpin_is_a_dry_run_by_default(creator_factory):
    creator = _creator(creator_factory)
    pinned = _page(creator, PROFILE_ADDR)

    out = _run()

    assert "1 page(s) across 1 creator(s)" in out
    pinned.refresh_from_db()
    assert pinned.p2paddr == PROFILE_ADDR


@pytest.mark.django_db
def test_unpin_clears_only_recent_exact_copies(creator_factory):
    creator = _creator(creator_factory)
    recent_copy = _page(creator, PROFILE_ADDR)
    old_copy = _page(creator, PROFILE_ADDR)
    _set_updated(
        old_copy, datetime.datetime(2023, 7, 1, tzinfo=datetime.timezone.utc),
    )
    deliberate_other = _page(creator, PAGE_ADDR)
    inheriting = _page(creator)

    out = _run("--execute")

    assert "Cleared 1 page address(es)." in out
    for page, expected in (
        (recent_copy, ""),
        (old_copy, PROFILE_ADDR),
        (deliberate_other, PAGE_ADDR),
        (inheriting, ""),
    ):
        page.refresh_from_db()
        assert page.p2paddr == expected
    # Effective address unchanged: no money moves on the day it runs.
    assert recent_copy.get_p2paddr() == PROFILE_ADDR
    # A second run finds nothing.
    assert "Cleared 0 page address(es)." in _run("--execute")


@pytest.mark.django_db
def test_unpin_honours_since(creator_factory):
    creator = _creator(creator_factory)
    old_copy = _page(creator, PROFILE_ADDR)
    _set_updated(
        old_copy, datetime.datetime(2023, 7, 1, tzinfo=datetime.timezone.utc),
    )

    _run("--since", "2023-01-01", "--execute")

    old_copy.refresh_from_db()
    assert old_copy.p2paddr == ""


@pytest.mark.django_db(transaction=True)
def test_unpin_never_erases_an_address_saved_while_it_runs(creator_factory):
    """A deliberate new page address committed mid-run survives (codex review).

    The page is a pinned copy (A = A) when the command selects it. Before the
    command writes, the creator saves a deliberate override B -- holding the
    page row lock, uncommitted. A blind ``UPDATE... WHERE id IN (SELECT...
    JOIN creator...)`` waits for that lock, then clears B anyway, because the
    subquery's answer came from the snapshot where the page still read A. The
    command's per-page compare-and-swap must leave B alone.
    """
    creator = _creator(creator_factory)
    page = _page(creator, PROFILE_ADDR)

    writer_holds_lock = threading.Event()
    release_writer = threading.Event()
    errors = []

    def creator_saves_override():
        try:
            with transaction.atomic():
                row = zPage.objects.select_for_update().get(pk=page.pk)
                row.p2paddr = PAGE_ADDR
                row.save(update_fields=["p2paddr", "updated_at"])
                writer_holds_lock.set()
                if not release_writer.wait(timeout=20):
                    raise AssertionError("writer was never released")
        except Exception as exc:  # pragma: no cover - reported below
            errors.append(exc)
        finally:
            connection.close()

    outputs = []

    def run_command():
        try:
            outputs.append(_run("--execute"))
        except Exception as exc:  # pragma: no cover - reported below
            errors.append(exc)
        finally:
            connection.close()

    writer = threading.Thread(target=creator_saves_override)
    writer.start()
    assert writer_holds_lock.wait(timeout=10)

    command = threading.Thread(target=run_command)
    command.start()

    # Release the writer only once the command is blocked on a row lock, so
    # the command's selection provably read the pre-override A = A state.
    deadline = time.monotonic() + 15
    while True:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT count(*) FROM pg_stat_activity "
                "WHERE wait_event_type = 'Lock' AND datname = current_database()"
            )
            if cursor.fetchone()[0]:
                break
        assert command.is_alive(), (errors, outputs)
        assert time.monotonic() < deadline, "command never waited on the lock"
        time.sleep(0.05)
    release_writer.set()

    writer.join(timeout=20)
    command.join(timeout=20)
    assert not writer.is_alive() and not command.is_alive()
    assert not errors, errors
    assert "1 page(s) across 1 creator(s)" in outputs[0]
    assert "Cleared 0 page address(es)." in outputs[0]
    page.refresh_from_db()
    assert page.p2paddr == PAGE_ADDR


@pytest.mark.django_db(transaction=True)
def test_unpin_skips_a_row_held_past_the_lock_timeout(creator_factory):
    """A busy row is reported and skipped, never waited on indefinitely."""
    creator = _creator(creator_factory)
    busy = _page(creator, PROFILE_ADDR)
    free = _page(creator, PROFILE_ADDR)

    holding = threading.Event()
    release = threading.Event()

    def hold_row():
        try:
            with transaction.atomic():
                list(zPage.objects.select_for_update().filter(pk=busy.pk))
                holding.set()
                release.wait(timeout=20)
        finally:
            connection.close()

    holder = threading.Thread(target=hold_row)
    holder.start()
    try:
        assert holding.wait(timeout=10)
        out = _run("--execute", "--lock-timeout-ms", "200")
    finally:
        release.set()
        holder.join(timeout=20)

    assert f"page {busy.pk}: row busy" in out
    assert "Cleared 1 page address(es). Skipped 1 busy page(s)." in out
    busy.refresh_from_db()
    free.refresh_from_db()
    assert busy.p2paddr == PROFILE_ADDR
    assert free.p2paddr == ""
