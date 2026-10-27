"""Issue: a full ``Creator.save()`` must never write the 2Z balance.

The bug these tests exist for
-----------------------------
``dj.apps.tuzis.ledger`` moves 2Z with a conditional ``UPDATE... SET tuzis =
tuzis - x``, so the database does the arithmetic and concurrent spenders cannot
double-spend. ``CHECK (tuzis >= 0)`` is the floor under that.

Neither helps in the *other* direction. Any request that loaded a Creator and
later calls a full ``instance.save()`` writes every column back from the
in-memory instance, including a ``tuzis`` value read before the ledger moved
it::

    t0  request A loads creator (tuzis = 100)
    t1  request B: ledger.debit(creator, 40)   -> DB is now 60
    t2  request A: instance.save()             -> writes tuzis = 100

40 2Z created from nothing, and the constraint cannot object because 100 is a
legal value.

Every test below the "reproductions" heading FAILS on the code as it stood
before this change — that is what makes them evidence. The ones under
"regressions" pass on both, and exist so the guard cannot be paid for with
functionality.

Real Postgres, no mocks: the guarantee under test is a database write, so a
fake DB would prove nothing.
"""
from decimal import Decimal
import threading

import pytest
from django.contrib.admin.sites import AdminSite
from django.db import connection, transaction
from rest_framework.test import APIClient

from dj.apps.g12f.admin import CreatorAdmin
from dj.apps.g12f.models import Creator
from dj.apps.tuzis import ledger


def balance(user) -> Decimal:
    """The balance as the DATABASE sees it. Never trust an in-memory read."""
    return Creator.objects.values_list("tuzis", flat=True).get(pk=user.pk)


# ---------------------------------------------------------------------------
# Reproductions — each of these fails without the Creator.save() guard
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_full_save_does_not_restore_a_stale_balance(creator_factory):
    """The mechanism itself, with nothing else in the way.

    Two instances of one row, which is exactly what two overlapping requests
    have. Without the guard the final assert reads 100 and 40 2Z have been
    minted.
    """
    user = creator_factory(tuzis=Decimal("100"))

    # The instance a long-running request is holding.
    stale = Creator.objects.get(pk=user.pk)
    assert stale.tuzis == Decimal("100")

    # Something else spends money in the meantime.
    ledger.debit(user, Decimal("40"))
    assert balance(user) == Decimal("60")

    #...and the long-running request finishes, touching an unrelated column.
    stale.full_name = "Edited My Profile"
    stale.save()

    assert balance(user) == Decimal("60"), "a full save() minted 2Z"
    # The unrelated edit must still have landed.
    assert Creator.objects.get(pk=user.pk).full_name == "Edited My Profile"


@pytest.mark.django_db
def test_profile_patch_does_not_restore_a_stale_balance(creator_factory):
    """The reported path, over real HTTP.

    PATCH /api/auth/user/ -> CreatorProfileUpdateSerializer ->
    ModelSerializer.update() -> bare instance.save(). ``tuzis`` sitting in
    ``read_only_fields`` stops the client SETTING it and does nothing at all
    about the stale value being written back.
    """
    user = creator_factory(tuzis=Decimal("100"))

    # request.user is loaded when the request is authenticated, before the
    # handler runs — hand the client that instance, as DRF would.
    request_user = Creator.objects.get(pk=user.pk)
    client = APIClient()
    client.force_authenticate(user=request_user)

    ledger.debit(user, Decimal("40"))
    assert balance(user) == Decimal("60")

    response = client.patch(
        "/api/auth/user/",
        {"full_name": "Still Editing"},
        format="json",
    )
    assert response.status_code == 200, response.content

    assert balance(user) == Decimal("60"), "PATCH /api/auth/user/ minted 2Z"
    assert Creator.objects.get(pk=user.pk).full_name == "Still Editing"

    #...and the number handed back to the client is the one in the database.
    # Raised by the codex review: keeping the row right while the response
    # still says 100 is the same money bug wearing a different hat — the
    # SvelteKit settings page loads this response straight into its auth store,
    # so the user would see and be gated on a balance that does not exist.
    assert Decimal(response.json()["tuzis"]) == Decimal("60")


@pytest.mark.django_db
def test_password_change_does_not_restore_a_stale_balance(creator_factory):
    """A third-party writer we could never have fixed with update_fields.

    POST /api/auth/password/change/ -> dj-rest-auth PasswordChangeSerializer ->
    django.contrib.auth.forms.SetPasswordForm.save() -> bare ``user.save()``.
    That last call is in Django itself. The only place a rule can be enforced
    for it is the model.
    """
    user = creator_factory(tuzis=Decimal("100"))

    request_user = Creator.objects.get(pk=user.pk)
    client = APIClient()
    client.force_authenticate(user=request_user)

    ledger.debit(user, Decimal("40"))
    assert balance(user) == Decimal("60")

    response = client.post(
        "/api/auth/password/change/",
        {
            # The current password is required on this route since;
            # CreatorFactory's default. This test is about the balance write,
            # so give the route what it needs to reach it.
            "old_password": "password",
            "new_password1": "a-long-enough-new-password",
            "new_password2": "a-long-enough-new-password",
        },
        format="json",
    )
    assert response.status_code == 200, response.content

    assert balance(user) == Decimal("60"), "changing a password minted 2Z"
    # The password really did change — the guard narrowed the write, it did
    # not swallow it.
    assert Creator.objects.get(pk=user.pk).check_password(
        "a-long-enough-new-password"
    )


@pytest.mark.django_db
def test_ban_and_soft_delete_does_not_restore_a_stale_balance(creator_factory):
    """Moderation must not hand money back to the account it is banning.

    ``ban_and_soft_delete()`` walks every relation before its full ``save()``,
    so the window between loading the instance and writing it is as wide as
    that walk. aiscore_comments only avoided this by remembering to re-fetch
    under ``select_for_update`` first — a convention, one caller deep.
    """
    user = creator_factory(tuzis=Decimal("100"))

    stale = Creator.objects.get(pk=user.pk)
    ledger.debit(user, Decimal("40"))
    assert balance(user) == Decimal("60")

    stale.ban_and_soft_delete()

    assert balance(user) == Decimal("60"), "banning a user minted 2Z"
    assert Creator.objects.get(pk=user.pk).is_active is False


@pytest.mark.django_db(transaction=True)
def test_overlapping_request_and_debit_on_two_connections_cannot_mint(
    creator_factory,
):
    """Two real connections, two real transactions, the losing interleaving.

    The interleaving is FORCED rather than raced, on purpose. Only one of the
    two possible orders loses money — the edit's UPDATE landing after the
    debit's commit — and a plain ``threading.Barrier`` does not produce it
    reliably: the editing thread has nothing to do after the barrier but one
    UPDATE, while the spending thread still has a SELECT ahead of it, so the
    edit wins the coin flip nearly every time and the test passes on BROKEN
    code. A coin-flip test is not evidence. Handshaking the two threads pins
    the order that actually costs money and makes the result mean something.

    Everything else here is real: separate connections, separate committed
    transactions, real Postgres.
    """
    user = creator_factory(tuzis=Decimal("100"))

    loaded = threading.Event()   # request A has its (about to be stale) copy
    debited = threading.Event()  # request B's debit has COMMITTED
    errors = []

    def long_running_request():
        """Loads the user, does slow work, then saves — the  shape."""
        try:
            stale = Creator.objects.get(pk=user.pk)
            loaded.set()
            assert debited.wait(timeout=10), "debit never committed"
            stale.full_name = "edited on a stale instance"
            stale.save()
        except Exception as exc:  # pragma: no cover - reported below
            errors.append(exc)
        finally:
            connection.close()

    def spender():
        try:
            assert loaded.wait(timeout=10), "request A never loaded the user"
            with transaction.atomic():
                ledger.debit(Creator.objects.get(pk=user.pk), Decimal("40"))
            debited.set()
        except Exception as exc:  # pragma: no cover - reported below
            errors.append(exc)
            debited.set()
        finally:
            connection.close()

    threads = [
        threading.Thread(target=long_running_request),
        threading.Thread(target=spender),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    for t in threads:
        assert not t.is_alive(), "worker thread deadlocked"
    assert not errors, errors

    assert balance(user) == Decimal("60"), (
        "an overlapping request reverted a committed debit"
    )
    assert Creator.objects.get(pk=user.pk).full_name == "edited on a stale instance"


@pytest.mark.django_db
def test_detached_instance_with_an_existing_pk_cannot_zero_the_balance(
    creator_factory,
):
    """`Creator(pk=<existing>,...).save()` is an UPDATE, not an INSERT.

    Found by the codex adversarial review of this change. ``_state.adding`` is
    True for any hand-constructed instance, but it does NOT imply an INSERT:
    with the pk set and no ``force_insert``, Django tries an UPDATE against
    that row first, and Creator's pk is a plain AutoField so none of Django's
    "pk has a default, must be an insert" shortcuts apply.

    Guarding on ``_state.adding`` therefore left the worst variant wide open —
    a detached instance carries the FIELD DEFAULT of 0, so an import or repair
    script written in this ordinary Django style would not restore a stale
    balance, it would wipe the balance to zero.
    """
    user = creator_factory(tuzis=Decimal("100"))

    detached = Creator(pk=user.pk, username=user.username, full_name="repaired")
    assert detached._state.adding is True
    assert detached.tuzis == Decimal("0"), "field default, not the real balance"

    detached.save()

    assert balance(user) == Decimal("100"), "a detached save() destroyed 2Z"
    assert Creator.objects.get(pk=user.pk).full_name == "repaired"


@pytest.mark.django_db
def test_save_to_another_database_alias_still_refuses_the_balance(
    creator_factory,
):
    """The guard must not switch itself off when the aliases disagree.

    Also from the codex review. Django's own deferred-field narrowing bails out
    when ``using != self._state.db``, and mirroring that here would have
    disabled the protection in exactly the configuration that needs it most: an
    instance read from a replica, saved to primary, writing back the balance
    the replica had before the ledger moved it on primary. There is one
    database today; there is no reason to leave a loaded gun for the day there
    are two.

    Both aliases point at the same test database here, so this cannot simulate
    replication lag — but it does go through the real ``save()``, not just the
    helper that computes the column list. The codex review caught the first
    version asserting on the helper alone: a later refactor could reintroduce
    the alias bail-out in ``save()`` and that test would have stayed green.
    """
    user = creator_factory(tuzis=Decimal("100"))

    stale = Creator.objects.get(pk=user.pk)
    stale._state.db = "replica-ish"  # pretend it was read somewhere else
    ledger.debit(user, Decimal("40"))
    assert stale.tuzis == Decimal("100"), "the stale read we are defending against"

    stale.full_name = "saved across aliases"
    stale.save(using="default")

    assert balance(user) == Decimal("60"), "a cross-alias save reverted a debit"
    assert Creator.objects.get(pk=user.pk).full_name == "saved across aliases"


def test_admin_cannot_edit_the_balance():
    """The guard would otherwise make the admin's `tuzis` box a silent lie.

    A staff user could type a number, hit save, get no error, and see nothing
    change. Read-only is the honest rendering — and the admin change form is
    the worst instance of the stale read anyway, since a human can leave it
    open for minutes.
    """
    admin = CreatorAdmin(Creator, AdminSite())
    assert "tuzis" in admin.get_readonly_fields(request=None)


# ---------------------------------------------------------------------------
# Regressions — these pass before AND after; they price the guard
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_insert_still_writes_the_starting_balance(creator_factory):
    """An INSERT has to write every column. It also cannot clobber anybody."""
    user = creator_factory(tuzis=Decimal("1000"))
    assert balance(user) == Decimal("1000")

    fresh = Creator(username="zz-insert-tuzis", tuzis=Decimal("7.500"))
    fresh.save()
    assert balance(fresh) == Decimal("7.500")


@pytest.mark.django_db
def test_force_insert_with_a_chosen_pk_still_works(creator_factory):
    """The documented way to insert a row with a chosen pk is left alone.

    Narrowing an UPDATE means Django no longer falls back to an INSERT when the
    pk matches no row — it raises instead. That fallback is worth losing (it
    resurrected concurrently-deleted accounts), and `force_insert=True` is the
    supported way to say "insert this", so it must keep working and must keep
    writing the balance.
    """
    creator_factory(tuzis=Decimal("1"))  # take up a row so the pk is chosen
    chosen_pk = Creator.objects.order_by("-pk").first().pk + 1000

    seeded = Creator(
        pk=chosen_pk, username="zz-force-insert", tuzis=Decimal("55.500")
    )
    seeded.save(force_insert=True)

    assert balance(seeded) == Decimal("55.500")


@pytest.mark.django_db
def test_explicit_update_fields_still_writes_the_balance(creator_factory):
    """The escape hatch stays open for anyone who genuinely means it.

    Implicit writes are the bug; a caller who types the column name has stated
    intent, and it greps.
    """
    user = creator_factory(tuzis=Decimal("100"))
    user.tuzis = Decimal("5")
    user.save(update_fields=["tuzis"])
    assert balance(user) == Decimal("5")


@pytest.mark.django_db
def test_positional_update_fields_still_writes_the_balance(creator_factory):
    """...including through save()'s deprecated positional signature.

    ``save(False, False, None, ["tuzis"])`` must not be a way to sneak past the
    guard in either direction: it is explicit, so it is honoured.
    """
    user = creator_factory(tuzis=Decimal("100"))
    user.tuzis = Decimal("3")
    user.save(False, False, None, ["tuzis"])
    assert balance(user) == Decimal("3")


@pytest.mark.django_db
def test_full_save_still_writes_every_other_column(creator_factory):
    """Protected ledger/cache columns are fenced off. Nothing else may be."""
    user = creator_factory(tuzis=Decimal("100"))
    user.full_name = "New Name"
    user.description = "New description"
    user.member_price = Decimal("42")
    user.strikes = 2
    user.is_active = False
    user.email = "moved@example.com"
    user.save()

    row = Creator.objects.get(pk=user.pk)
    assert row.full_name == "New Name"
    assert row.description == "New description"
    assert row.member_price == Decimal("42")
    assert row.strikes == 2
    assert row.is_active is False
    assert row.email == "moved@example.com"


@pytest.mark.django_db
def test_full_save_still_bumps_updated_at(creator_factory):
    """`updated_at` is auto_now; narrowing a save must not freeze it."""
    user = creator_factory(tuzis=Decimal("100"))
    before = Creator.objects.get(pk=user.pk).updated_at

    user.full_name = "Touched"
    user.save()

    assert Creator.objects.get(pk=user.pk).updated_at > before


@pytest.mark.django_db
def test_deferred_instance_still_saves(creator_factory):
    """`.only()`/`.defer()` instances must not fetch-per-column or blow up."""
    user = creator_factory(tuzis=Decimal("100"))

    partial = Creator.objects.only("username", "full_name").get(pk=user.pk)
    partial.full_name = "Deferred Edit"
    partial.save()

    row = Creator.objects.get(pk=user.pk)
    assert row.full_name == "Deferred Edit"
    assert row.tuzis == Decimal("100")


@pytest.mark.django_db
def test_saving_a_balance_only_instance_writes_nothing(creator_factory):
    """`.only("tuzis")` leaves nothing a full save is allowed to write.

    The narrowed column list comes out empty and Django skips the write
    entirely. Writing nothing is the safe answer: the balance is the ONLY thing
    such a save could have written, which is exactly the bug. Flagged as
    uncovered by the codex review.
    """
    user = creator_factory(tuzis=Decimal("100"))

    partial = Creator.objects.only("tuzis").get(pk=user.pk)
    ledger.debit(user, Decimal("40"))
    partial.tuzis = Decimal("999")
    partial.save()

    assert balance(user) == Decimal("60")
    #...and the instance is told the truth rather than left holding 999.
    assert partial.tuzis == Decimal("60")


@pytest.mark.django_db
def test_ledger_still_moves_money(creator_factory):
    """The guard is aimed at save(), and the ledger does not use save()."""
    a = creator_factory(tuzis=Decimal("100"))
    b = creator_factory(tuzis=Decimal("0"))

    ledger.transfer(a, b, Decimal("30"))

    assert balance(a) == Decimal("70")
    assert balance(b) == Decimal("30")
    # The in-memory instances are resynced, as callers depend on.
    assert a.tuzis == Decimal("70")
    assert b.tuzis == Decimal("30")


@pytest.mark.django_db
def test_constraint_still_rejects_a_negative_balance(creator_factory):
    """'s floor is untouched: explicit writes still meet the CHECK."""
    from django.db.utils import IntegrityError

    user = creator_factory(tuzis=Decimal("1"))
    user.tuzis = Decimal("-0.001")
    with pytest.raises(IntegrityError):
        with transaction.atomic():
            user.save(update_fields=["tuzis"])
