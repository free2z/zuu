"""``manage.py recovery_census`` -- the operator's measurement.

The runbook (``docs/runbooks/account-recovery.md``) tells support to act on
this command's output, so what it must not do is quietly miscount. Two
properties carry the weight:

* it classifies each of the states the issue names -- recoverable, no address,
  unconfirmed, suppressed, hard-locked -- and puts each account in exactly one
  recovery bucket;
* it **never prints an email address or a password hash**, on any flag, in any
  output mode. A census gets pasted into tickets and read out of Job logs.
"""
import json

import pytest
from django.core.management import CommandError, call_command
from django.utils import timezone

from datetime import timedelta
from io import StringIO

from dj.apps.emails.models import Email, OptOutEmail
from dj.apps.ktauth.epoch import EVENT_PASSWORD_CHANGE, bump_account_epoch
from dj.apps.otp.models import OTPSecret
from dj.apps.social.models import SocialIdentity
from dj.apps.twitter.models import TwitterProfile
from dj.apps.zauth.models import ZcashIdentity


def _make_email(user, address, *, confirmed, expired=False):
    return Email.objects.create(
        user=user,
        email=address,
        token="tok-" + address,
        expires_at=(
            timezone.now() - timedelta(hours=1) if expired
            else timezone.now() + timedelta(hours=1)
        ),
        confirmed_at=timezone.now() if confirmed else None,
    )


def _passwordless(user):
    user.set_unusable_password()
    user.save(update_fields=["password", "password_set", "updated_at"])
    return user


def _census(**kwargs):
    out = StringIO()
    call_command("recovery_census", "--json", stdout=out, **kwargs)
    return json.loads(out.getvalue())


@pytest.mark.django_db
def test_each_account_lands_in_exactly_one_recovery_bucket(creator_factory):
    recoverable = creator_factory()
    _make_email(recoverable, "ok@example.com", confirmed=True)

    unconfirmed = creator_factory()
    _make_email(unconfirmed, "pending@example.com", confirmed=False)

    stale = creator_factory()
    _make_email(stale, "stale@example.com", confirmed=False, expired=True)

    suppressed = creator_factory()
    _make_email(suppressed, "gone@example.com", confirmed=True)
    OptOutEmail.objects.create(email="gone@example.com")

    creator_factory()  # no address at all

    report = _census()
    recovery = report["recovery"]

    assert recovery["recoverable"] == 1
    assert recovery["unconfirmed_address"] == 1
    assert recovery["expired_or_stale_address"] == 1
    assert recovery["suppressed_address"] == 1
    assert recovery["no_address_at_all"] == 1
    assert recovery["not_recoverable"] == 4
    # The buckets partition the not-recoverable set: no account counted twice,
    # none dropped. A miscount here is a support queue that is wrong by
    # however many accounts fell through.
    assert (
        recovery["unconfirmed_address"]
        + recovery["expired_or_stale_address"]
        + recovery["suppressed_address"]
        + recovery["no_address_at_all"]
    ) == recovery["not_recoverable"]
    assert recovery["recoverable"] + recovery["not_recoverable"] == 5


@pytest.mark.django_db
def test_a_confirmed_but_suppressed_address_is_not_recoverable(
    creator_factory
):
    """The trap: confirmed, and still mailed nothing."""
    user = creator_factory()
    _make_email(user, "gone@example.com", confirmed=True)

    assert _census()["recovery"]["recoverable"] == 1, "control"

    OptOutEmail.objects.create(email="gone@example.com")

    report = _census()
    assert report["recovery"]["recoverable"] == 0
    assert report["recovery"]["suppressed_address"] == 1
    assert report["suppressed"]["accounts_holding_a_suppressed_address"] == 1


@pytest.mark.django_db
def test_hard_locked_splits_by_whether_any_door_exists(creator_factory):
    """ fixes some of these people. Only the runbook fixes the last one."""
    with_x = _passwordless(creator_factory())
    TwitterProfile.objects.create(
        creator=with_x, twitter_id="1", username="withx", allow_login=True,
    )

    with_social = _passwordless(creator_factory())
    SocialIdentity.objects.create(
        creator=with_social, provider="x", provider_uid="99",
    )

    # A wallet-only account: no password, no address, and a login that works
    # perfectly. Counting this as "no login method" is what sent support at a
    # manual password handover it did not need (codex adversarial review).
    with_wallet = _passwordless(creator_factory())
    ZcashIdentity.objects.create(creator=with_wallet, zcash_address="t1wallet")

    _passwordless(creator_factory())  # no door at all

    # Has no recovery but DOES have a password -- not hard-locked.
    creator_factory()

    report = _census()

    assert report["hard_locked"]["total"] == 4
    assert report["hard_locked"]["login_identity_available"] == 3
    assert report["hard_locked"]["no_login_method"] == 1
    assert report["passwords"]["unusable"] == 4
    assert report["passwords"]["usable"] == 1
    assert report["login_methods"]["zcash_identities"] == 1


@pytest.mark.django_db
def test_a_wallet_only_account_is_not_filed_as_unreachable(creator_factory):
    """The narrow control for the finding above, stated on its own."""
    user = _passwordless(creator_factory())

    assert _census()["hard_locked"]["no_login_method"] == 1, "control"

    ZcashIdentity.objects.create(creator=user, zcash_address="t1onlywallet")

    report = _census()
    assert report["hard_locked"]["no_login_method"] == 0
    assert report["hard_locked"]["login_identity_available"] == 1


@pytest.mark.django_db
def test_a_revoked_confirmation_link_is_not_counted_as_pending(
    creator_factory
):
    """Same  rule ConfirmEmailView enforces and the endpoint reports."""
    user = creator_factory()
    _make_email(user, "revoked@example.com", confirmed=False)

    assert _census()["recovery"]["unconfirmed_address"] == 1, "control"

    bump_account_epoch(user.pk, event=EVENT_PASSWORD_CHANGE)

    report = _census()
    assert report["recovery"]["unconfirmed_address"] == 0
    assert report["recovery"]["expired_or_stale_address"] == 1


@pytest.mark.django_db
def test_an_empty_password_hash_is_counted_not_hidden(creator_factory):
    """Django calls an empty hash USABLE; nothing can ever match it.

    The census must agree with ``has_usable_password()`` so support and the
    account holder see one world -- and must surface the anomaly rather than
    folding it into ``unusable``, where it would look like an ordinary
    passwordless account.
    """
    user = creator_factory()
    user.password = ""
    user.save(update_fields=["password"])

    report = _census()

    assert report["passwords"]["empty_hash"] == 1
    assert report["passwords"]["usable"] == 1, "matches has_usable_password()"
    assert report["passwords"]["unusable"] == 0
    user.refresh_from_db()
    assert user.has_usable_password() is True, "the predicate we must match"


def _one(username):
    out = StringIO()
    call_command("recovery_census", "--json", "--username", username, stdout=out)
    return json.loads(out.getvalue())


def _one_printed(username):
    out = StringIO()
    call_command("recovery_census", "--username", username, stdout=out)
    return out.getvalue()


@pytest.mark.django_db
def test_the_single_account_report_flags_a_stale_identity(creator_factory):
    """The HIGH finding: support must not accept a revoked identity as proof."""
    user = creator_factory()
    TwitterProfile.objects.create(
        creator=user, twitter_id="1", username="planted", allow_login=True,
    )

    assert "STALE" not in _one_printed(user.username), "control"
    assert _one(user.username)["stale_identities"] == 0

    # An ownership event: whoever held this account was evicted, and the
    # identity linked before it is now exactly what an attacker is left with.
    bump_account_epoch(user.pk, event=EVENT_PASSWORD_CHANGE)

    printed = _one_printed(user.username)
    assert "identity STALE" in printed
    assert "WARNING:" in printed and "STALE" in printed

    report = _one(user.username)
    assert report["stale_identities"] == 1
    row_created = TwitterProfile.objects.get(twitter_id="1").created_at
    assert report["identities"] == [{
        "family": "twitter_login",
        "provider": "twitter-legacy",
        "stable_uid": "1",
        "linked_at_epoch": 1,
        "row_created_at": row_created.isoformat(),
        "current": False,
    }]


@pytest.mark.django_db
def test_a_current_identity_does_not_launder_a_stale_sibling(creator_factory):
    """Round 2's HIGH finding, and the reason verdicts are per identity.

    An attacker's X link goes stale at the owner's password reset; the owner
    then links Google. A per-family ``any()`` answered "current" and printed
    no warning --- so an operator checking that boolean would accept a nonce
    from the attacker's revoked X account.
    """
    user = creator_factory()
    SocialIdentity.objects.create(
        creator=user, provider="x", provider_uid="attacker-uid",
    )
    bump_account_epoch(user.pk, event=EVENT_PASSWORD_CHANGE)
    user.refresh_from_db()
    # Linked AFTER the eviction, so this one is current.
    SocialIdentity.objects.create(
        creator=user, provider="google", provider_uid="owner-uid",
        linked_at_epoch=user.kt_account_epoch,
    )

    report = _one(user.username)

    by_uid = {i["stable_uid"]: i for i in report["identities"]}
    assert by_uid["attacker-uid"]["current"] is False
    assert by_uid["owner-uid"]["current"] is True
    # The count support reads must still be nonzero -- this is the assertion
    # that goes red under the old per-family any().
    assert report["stale_identities"] == 1
    printed = _one_printed(user.username)
    assert "identity STALE    x uid=attacker-uid" in printed
    assert "identity CURRENT  google uid=owner-uid" in printed
    assert "WARNING:" in printed
    # Round 6: the "CURRENT is not the owner" caveat used to be suppressed as
    # soon as any sibling was STALE -- i.e. on exactly the account that has
    # already shown an ownership event. It must print alongside the WARNING.
    assert "CURRENT means 'not revoked', never 'is the owner'" in printed


@pytest.mark.django_db
def test_a_planted_identity_reads_current_so_the_link_time_is_printed(
    creator_factory
):
    """Round 3: linking does not bump the epoch, so CURRENT proves nothing.

    An identity an attacker plants during a stolen session is ``CURRENT`` from
    creation with no warning. ``row_created_at`` is the operator's only
    signal, so it must reach the report and the printed line -- and it is
    deliberately NOT called ``linked_at``, because no attachment time is
    recorded and an orphaned row can be adopted long after it was created.
    """
    user = creator_factory()
    SocialIdentity.objects.create(
        creator=user, provider="x", provider_uid="planted-99999",
        linked_at_epoch=user.kt_account_epoch,
    )

    report = _one(user.username)

    planted = report["identities"][0]
    assert planted["current"] is True, "the trap: no epoch bump on link"
    assert report["stale_identities"] == 0
    assert planted["row_created_at"] is not None
    assert "linked_at" not in planted, "the name must not claim more"
    assert planted["row_created_at"] == SocialIdentity.objects.get(
        provider_uid="planted-99999",
    ).verified_at.isoformat()

    printed = _one_printed(user.username)
    assert f"row_created_at={planted['row_created_at']}" in printed
    # And the operator is told what CURRENT does and does not mean.
    assert "CURRENT means 'not revoked', never 'is the owner'" in printed


@pytest.mark.django_db
def test_an_adopted_orphan_keeps_its_old_row_timestamp(creator_factory):
    """Round 4 HIGH: the timestamp is row creation, NOT attachment.

    ``TwitterProfile.creator`` is nullable -- an interrupted OAuth flow leaves
    an orphaned row -- and ``dj.apps.twitter.views`` adopts one with
    ``update_fields=['creator', 'linked_at_epoch']``. ``created_at`` is
    ``auto_now_add`` and never moves. So an attacker holding an old orphaned
    profile can attach it today and the census still prints a date from years
    ago, ``CURRENT``, indistinguishable from a long-standing link.

    The field is therefore named ``row_created_at``, and the operator note
    says the signal only ever accuses.
    """
    orphan = TwitterProfile.objects.create(
        creator=None, twitter_id="orphan-1", username="orphan",
        allow_login=True,
    )
    TwitterProfile.objects.filter(pk=orphan.pk).update(
        created_at=timezone.now() - timedelta(days=1000),
    )

    user = _passwordless(creator_factory())
    # Exactly what the adopt path writes.
    orphan.creator = user
    orphan.linked_at_epoch = user.kt_account_epoch
    orphan.save(update_fields=["creator", "linked_at_epoch"])

    report = _one(user.username)
    entry = report["identities"][0]

    assert entry["current"] is True, "adopted today, so not revoked"
    aged = timezone.now() - timezone.datetime.fromisoformat(
        entry["row_created_at"]
    )
    assert aged > timedelta(days=900), (
        "the row timestamp did NOT move on adoption -- which is the point: "
        "an old date must never be read as an old association"
    )
    assert "linked_at" not in entry

    printed = _one_printed(user.username)
    assert "row_created_at=" in printed
    assert "an OLD date proves nothing" in printed


@pytest.mark.django_db
def test_an_account_with_no_identities_says_the_gate_is_inapplicable(
    creator_factory
):
    """Round 3 HIGH: §3a's gate was silently vacuous for exactly this set.

    ``hard_locked.no_login_method`` is the population §3 exists to serve, and
    for it the report printed no identity line, ``stale_identities 0`` and no
    warning -- so "only once the identity is current" bound to nothing and an
    operator could read the precondition as satisfied.
    """
    user = _passwordless(creator_factory())

    report = _one(user.username)
    assert report["identities"] == []
    assert report["stale_identities"] == 0
    assert report["hard_locked"] is True

    printed = _one_printed(user.username)
    assert "NO LINKED IDENTITIES" in printed
    assert "NOT the same as passing it" in printed
    # The reassuring note about CURRENT must NOT fire here -- there is nothing
    # current to reassure anybody about.
    assert "CURRENT means" not in printed


@pytest.mark.django_db
def test_a_confirmed_but_suppressed_row_is_not_a_creator_email_lead(
    creator_factory
):
    """Round 3 NIT: the lead list subtracted the suppression-filtered set."""
    user = creator_factory(email="typed@example.com")
    _make_email(user, "confirmed@example.com", confirmed=True)
    OptOutEmail.objects.create(email="confirmed@example.com")

    report = _census()

    # The account HAS a confirmed row. Suppression is reported separately; it
    # must not relabel this account as having no confirmed row.
    assert report["creator_email_column"][
        "set_but_no_confirmed_email_row"
    ] == 0
    assert report["recovery"]["suppressed_address"] == 1


@pytest.mark.django_db
def test_the_detail_view_agrees_with_the_summary_about_suppressed_pending(
    creator_factory
):
    """The module docstring claims the two MUST agree. Round 3: they did not."""
    user = creator_factory()
    _make_email(user, "sup@example.com", confirmed=False)
    OptOutEmail.objects.create(email="sup@example.com")

    summary = _census()
    detail = _one(user.username)

    assert summary["recovery"]["unconfirmed_address"] == 0
    assert summary["recovery"]["suppressed_address"] == 1
    assert detail["email_pending"] is False
    assert detail["email_suppressed"] is True


@pytest.mark.django_db
def test_an_enrolled_factor_is_flagged_for_support(creator_factory):
    """§3b hands back a password onto a door that still asks for a code."""
    user = creator_factory()
    _make_email(user, "mfa@example.com", confirmed=True)

    assert _one(user.username)["mfa_required"] is False, "control"

    OTPSecret.objects.create(
        user=user, secret="JBSWY3DPEHPK3PXP", is_active=True,
    )

    report = _one(user.username)
    assert report["mfa_required"] is True
    # Still "recoverable" by email -- which is exactly why the warning has to
    # be printed rather than folded into can_recover.
    assert report["can_recover"] is True
    printed = _one_printed(user.username)
    assert "WARNING: MFA is enrolled" in printed
    # Round 6's HIGH: identity evidence is first-factor-only for an enrolled
    # account, so the census must not route support to a removal.
    assert "Support does NOT hand over or remove MFA" in printed


@pytest.mark.django_db
def test_a_recoverable_account_is_never_hard_locked(creator_factory):
    """No password, but a confirmed address -- the reset SETS a password."""
    user = _passwordless(creator_factory())
    _make_email(user, "ok@example.com", confirmed=True)

    report = _census()

    assert report["recovery"]["recoverable"] == 1
    assert report["hard_locked"]["total"] == 0
    assert report["passwords"]["unusable"] == 1


@pytest.mark.django_db
def test_the_stale_password_set_flag_is_counted_not_trusted(creator_factory):
    """g12f 0081 only backfilled ``password=''``; a ``!`` hash kept its flag."""
    user = creator_factory()
    user.set_unusable_password()
    user.password_set = True
    user.save(update_fields=["password", "password_set", "updated_at"])

    report = _census()

    assert report["passwords"]["unusable"] == 1, "the hash is authoritative"
    assert report["passwords"]["flag_disagrees_with_hash"] == 1
    assert report["hard_locked"]["total"] == 1


@pytest.mark.django_db
def test_an_unconfirmed_creator_email_column_is_reported_as_a_lead(
    creator_factory
):
    """``Creator.email`` is writable from the profile PATCH and confirms nothing.

    Someone who typed their address into profile settings believes they have a
    recovery address. The reset lookup does not read that column, so they do
    not. Support needs the number; it is never a credential.
    """
    creator_factory(email="typed-into-settings@example.com")
    confirmed = creator_factory(email="also@example.com")
    _make_email(confirmed, "also@example.com", confirmed=True)

    report = _census()

    assert report["creator_email_column"]["set_but_no_confirmed_email_row"] == 1


@pytest.mark.django_db
def test_list_locked_names_the_accounts_without_naming_their_addresses(
    creator_factory
):
    locked = _passwordless(creator_factory())
    TwitterProfile.objects.create(
        creator=locked, twitter_id="1", username="lockedx", allow_login=True,
    )
    _make_email(locked, "secret@example.com", confirmed=False)

    report = _census(list_locked=True)

    assert [entry["username"] for entry in report["locked"]] == [
        locked.username
    ]
    assert report["locked"][0]["twitter_login"] is True
    assert "secret@example.com" not in json.dumps(report)


@pytest.mark.django_db
def test_no_output_mode_ever_prints_an_address_or_a_hash(creator_factory):
    """Negative control against the obvious way to leak one: just print it."""
    user = _passwordless(creator_factory())
    _make_email(user, "secret@example.com", confirmed=True)
    OptOutEmail.objects.create(email="secret@example.com")
    hashed = user.password

    for kwargs in ({}, {"list_locked": True}, {"username": user.username}):
        for as_json in (True, False):
            out = StringIO()
            args = ["--json"] if as_json else []
            call_command("recovery_census", *args, stdout=out, **kwargs)
            printed = out.getvalue()
            assert "secret@example.com" not in printed, (kwargs, as_json)
            assert hashed not in printed, (kwargs, as_json)


@pytest.mark.django_db
def test_the_single_account_report_matches_the_census_rule(creator_factory):
    user = creator_factory()
    _make_email(user, "ok@example.com", confirmed=True)

    out = StringIO()
    call_command(
        "recovery_census", "--json", "--username", user.username, stdout=out
    )
    report = json.loads(out.getvalue())

    assert report["can_recover"] is True
    assert report["hard_locked"] is False
    assert report["account"]["username"] == user.username

    OptOutEmail.objects.create(email="ok@example.com")
    out = StringIO()
    call_command(
        "recovery_census", "--json", "--username", user.username, stdout=out
    )
    assert json.loads(out.getvalue())["can_recover"] is False


@pytest.mark.django_db
def test_an_unknown_username_is_an_error_not_an_empty_report():
    with pytest.raises(CommandError):
        call_command("recovery_census", "--username", "nobody-at-all")


@pytest.mark.django_db
def test_the_command_cannot_write(creator_factory):
    """The read-only transaction is the guard, not the author's good manners.

    ``manage.py`` commands get no ``AtomicMiddleware``; this one wraps itself
    and asks PostgreSQL to refuse writes. Proving it means proving a write
    inside that block raises -- so the command is run with a write monkeypatched
    into the section that builds the report.
    """
    from dj.apps.emails.management.commands import recovery_census

    original = recovery_census.Command._census

    def _writes(self, **kwargs):
        OptOutEmail.objects.create(email="sneaky@example.com")
        return original(self, **kwargs)

    creator_factory()
    recovery_census.Command._census = _writes
    try:
        with pytest.raises(Exception) as excinfo:
            call_command("recovery_census", stdout=StringIO())
        assert "read-only" in str(excinfo.value).lower()
    finally:
        recovery_census.Command._census = original
    assert not OptOutEmail.objects.filter(email="sneaky@example.com").exists()
