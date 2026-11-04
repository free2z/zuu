"""Every enumerated ownership event actually moves the counter.

``dj.apps.ktauth.epoch``'s docstring says which events increment
``kt_account_epoch`` and why. That list **is** the security property: an event
that should invalidate outstanding assertions but does not increment leaves
exactly the replay window rule A15 exists to close, and it leaves it silently,
because nothing anywhere goes red.

So each one is exercised through its real route rather than by calling
:func:`bump_account_epoch` directly. A test that calls the helper proves the
helper works; only a test that posts to the endpoint proves the endpoint calls
it. The two identity-provider events live beside their own OAuth fixtures --
``dj/apps/social/test_social.py`` and ``dj/apps/zauth/test_zauth.py`` -- because
reproducing a provider exchange here would be a second, drifting copy of them.
"""

from datetime import timedelta

import pytest
from django.contrib.admin.sites import AdminSite
from django.utils import timezone
from rest_framework.test import APIClient

from dj.apps.emails.models import Email, PasswordResetToken
from dj.apps.g12f.admin import CreatorAdmin
from dj.apps.g12f.models import Creator
from dj.apps.ktauth.epoch import INITIAL_ACCOUNT_EPOCH

pytestmark = pytest.mark.django_db


def epoch_of(user) -> int:
    return Creator.objects.values_list("kt_account_epoch", flat=True).get(
        pk=user.pk
    )


def confirmed_email(user, address):
    return Email.objects.create(
        user=user,
        email=address,
        token="email-token",
        expires_at=timezone.now() + timedelta(hours=1),
        confirmed_at=timezone.now(),
    )


# ------------------------------------------------------------------- passwords


def test_a_password_reset_is_an_ownership_event(creator_factory):
    """Account recovery, in the literal sense ``KT.md`` §4.5.4 names."""
    user = creator_factory(password="old-password")
    email = confirmed_email(user, "reset-bumps-epoch@example.com")
    token = PasswordResetToken.objects.create(email=email)
    before = epoch_of(user)

    response = APIClient().post(
        "/api/emails/do-reset-password",
        {"token": str(token.token), "password": "a-long-enough-new-password"},
        format="json",
    )

    assert response.status_code == 200, response.content
    assert epoch_of(user) == before + 1


def test_a_password_change_is_an_ownership_event(creator_factory):
    """``/api/emails/change-password`` -- the route the SvelteKit UI uses."""
    user = creator_factory(password="old-password")
    client = APIClient()
    client.force_authenticate(user=user)
    before = epoch_of(user)

    response = client.post(
        "/api/emails/change-password",
        {
            "old_password": "old-password",
            "new_password": "a-long-enough-changed-password",
            "confirm_password": "a-long-enough-changed-password",
        },
        format="json",
    )

    assert response.status_code == 200, response.content
    assert epoch_of(user) == before + 1


def test_the_dj_rest_auth_password_change_is_an_ownership_event(
    creator_factory,
):
    """``/api/auth/password/change/`` -- the sibling route, same event.

    Two routes replace a password on this platform. A counter wired to one of
    them and not the other is a replay window with a documented workaround.
    """
    user = creator_factory(password="old-password")
    client = APIClient()
    client.force_authenticate(user=user)
    before = epoch_of(user)

    response = client.post(
        "/api/auth/password/change/",
        {
            "old_password": "old-password",
            "new_password1": "a-long-enough-frontend-password",
            "new_password2": "a-long-enough-frontend-password",
        },
        format="json",
    )

    assert response.status_code == 200, response.content
    assert epoch_of(user) == before + 1


def test_a_refused_password_change_does_not_move_the_counter(creator_factory):
    """A spurious increment is safe, but it still spends an A18b step.

    The bump lives inside the transaction that writes the password, after the
    write, so a rejected attempt leaves the counter exactly where it was.
    """
    user = creator_factory(password="old-password")
    client = APIClient()
    client.force_authenticate(user=user)
    before = epoch_of(user)

    response = client.post(
        "/api/emails/change-password",
        {
            "old_password": "not-the-current-password",
            "new_password": "a-long-enough-changed-password",
            "confirm_password": "a-long-enough-changed-password",
        },
        format="json",
    )

    assert response.status_code >= 400
    assert epoch_of(user) == before


# ------------------------------------------------------------ recovery address


def test_replacing_an_unconfirmed_address_is_not_an_ownership_event(
    creator_factory, recent_login):
    """An unconfirmed address was never a recovery principal.

    Seventeen distinct pending addresses would otherwise walk the counter past
    the log's A18b bound having revoked nothing at all (codex adversarial
    review). The cheapest exhaustion lever there was.
    """
    user = creator_factory()
    Email.objects.create(
        user=user,
        email="never-confirmed@example.com",
        token="email-token",
        expires_at=timezone.now() + timedelta(hours=1),
    )
    client = APIClient()
    client.force_authenticate(user=user)
    recent_login(client, user)
    before = epoch_of(user)

    for i in range(3):
        response = client.post(
            "/api/emails/add", {"email": f"typo{i}@example.com"}, format="json"
        )
        assert response.status_code == 201, response.content

    assert epoch_of(user) == before


def test_a_first_address_is_not_an_ownership_event(creator_factory, recent_login):
    """Adding a recovery principal is an addition, and additions do not count."""
    user = creator_factory()
    client = APIClient()
    client.force_authenticate(user=user)
    recent_login(client, user)
    before = epoch_of(user)

    response = client.post(
        "/api/emails/add", {"email": "first@example.com"}, format="json"
    )

    assert response.status_code == 201, response.content
    assert epoch_of(user) == before


def test_changing_the_recovery_address_is_an_ownership_event(creator_factory, recent_login):
    """Replacing a CONFIRMED address revokes a live recovery principal."""
    user = creator_factory()
    confirmed_email(user, "before@example.com")
    client = APIClient()
    client.force_authenticate(user=user)
    recent_login(client, user)
    before = epoch_of(user)

    response = client.post(
        "/api/emails/add", {"email": "after@example.com"}, format="json"
    )

    assert response.status_code == 201, response.content
    assert epoch_of(user) == before + 1


def test_resending_a_confirmation_is_not_an_ownership_event(creator_factory):
    """Nothing changed, so nobody gained or lost the ability to recover.

    ``/api/emails/resend`` rotates the confirmation token against the address
    already on file. Counting that would spend an A18b step per impatient
    click, and the account would run out of headroom on the one thing the
    counter is for.
    """
    user = creator_factory()
    email = confirmed_email(user, "unchanged@example.com")
    # The endpoint refuses a resend inside five minutes of the last one.
    Email.objects.filter(pk=email.pk).update(
        updated_at=timezone.now() - timedelta(hours=1)
    )
    client = APIClient()
    client.force_authenticate(user=user)
    before = epoch_of(user)

    response = client.post("/api/emails/resend", format="json")

    assert response.status_code == 204, response.content
    assert epoch_of(user) == before


# -------------------------------------------------------------------- the admin


def _admin_save(user, changed_data, **attrs):
    """Drive ``CreatorAdmin.save_model`` the way the change form does."""

    class _Form:
        def __init__(self, changed):
            self.changed_data = list(changed)

    for name, value in attrs.items():
        setattr(user, name, value)
    CreatorAdmin(Creator, AdminSite()).save_model(
        request=None, obj=user, form=_Form(changed_data), change=True
    )


def test_an_admin_password_edit_is_an_ownership_event(creator_factory):
    """The literal "the account changed hands" path, done by a third party."""
    user = creator_factory(password="old-password")
    before = epoch_of(user)

    user.set_password("an-admin-chosen-password")
    _admin_save(user, ["password"])

    assert epoch_of(user) == before + 1


def test_an_admin_username_edit_is_not_an_ownership_event(creator_factory):
    """A rename moves the HANDLE, not the account, and A15 is per handle.

    The self-service rename does not count, so neither does the staff one --
    counting it would spend an A18b step on a case correction that changes
    neither the effective handle nor any principal (codex adversarial review).
    The per-account / per-handle mismatch this leaves is an activation blocker
    recorded in `dj.apps.ktauth.epoch`; no increment here can close it.
    """
    user = creator_factory(username="beforename")
    before = epoch_of(user)

    _admin_save(user, ["username"], username="aftername")

    assert epoch_of(user) == before


def test_an_admin_profile_edit_is_not_an_ownership_event(creator_factory):
    """Staff fixing a display name changed nobody's ability to sign in."""
    user = creator_factory()
    before = epoch_of(user)

    _admin_save(user, ["full_name"], full_name="Edited By Staff")

    assert epoch_of(user) == before


# --------------------------------------------------------------- legacy twitter


def test_deleting_a_twitter_link_is_an_ownership_event(creator_factory):
    """``dj.apps.twitter`` is a separate live login path, not a `social` provider.

    Missed on the first pass and found by the codex adversarial review, which
    is exactly the failure mode the enumeration exists to prevent: a credential
    family that looks superseded but still signs people in.
    """
    from dj.apps.twitter.models import TwitterProfile

    user = creator_factory()
    TwitterProfile.objects.create(
        creator=user, twitter_id="tw-1", username="tw_one",
    )
    client = APIClient()
    client.force_authenticate(user=user)
    before = epoch_of(user)

    response = client.delete("/api/twitter/delete")

    assert response.status_code == 204, response.content
    assert epoch_of(user) == before + 1


def test_disabling_twitter_login_counts_and_re_enabling_does_not(
    creator_factory, recent_login):
    """``allow_login`` off is a revocation; on is an addition.

    The asymmetry is the answer to a codex finding: counting both let any user
    exhaust the log's 16-epoch A18b budget by flipping one boolean.
    """
    from dj.apps.twitter.models import TwitterProfile

    user = creator_factory()
    TwitterProfile.objects.create(
        creator=user, twitter_id="tw-2", username="tw_two", allow_login=True,
    )
    client = APIClient()
    client.force_authenticate(user=user)
    before = epoch_of(user)

    off = client.put(
        "/api/twitter/public-status/",
        {"is_public": False, "allow_login": False},
        format="json",
    )
    assert off.status_code == 200, off.content
    assert epoch_of(user) == before + 1

    # Re-submitting the same state revoked nothing.
    again = client.put(
        "/api/twitter/public-status/",
        {"is_public": True, "allow_login": False},
        format="json",
    )
    assert again.status_code == 200, again.content
    assert epoch_of(user) == before + 1

    #...and turning it back on only ADDS a principal.
    user.refresh_from_db()
    recent_login(client, user)
    back_on = client.put(
        "/api/twitter/public-status/",
        {"is_public": True, "allow_login": True},
        format="json",
    )
    assert back_on.status_code == 200, back_on.content
    assert epoch_of(user) == before + 1


def test_passwordless_twitter_delete_cannot_remove_last_unmarked_identity(
    creator_factory,
):
    """A passwordless owner must reconnect before deleting their only X login."""
    from dj.apps.twitter.models import TwitterProfile

    user = creator_factory(username="passwordless-twitter-delete")
    user.set_unusable_password()
    user.save(update_fields=["password", "password_set", "updated_at"])
    profile = TwitterProfile.objects.create(
        creator=user,
        twitter_id="passwordless-twitter-delete-id",
        username="passwordless-twitter-delete",
    )
    client = APIClient()
    client.force_authenticate(user=user)
    before = epoch_of(user)

    response = client.delete("/api/twitter/delete")

    assert response.status_code == 409, response.content
    assert b"Set a password or reconnect another login method" in response.content
    assert TwitterProfile.objects.filter(pk=profile.pk).exists()
    assert epoch_of(user) == before


def test_passwordless_twitter_disable_cannot_remove_last_unmarked_identity(
    creator_factory,
):
    """Turning X login off has the same lockout guard as deleting it."""
    from dj.apps.twitter.models import TwitterProfile

    user = creator_factory(username="passwordless-twitter-disable")
    user.set_unusable_password()
    user.save(update_fields=["password", "password_set", "updated_at"])
    profile = TwitterProfile.objects.create(
        creator=user,
        twitter_id="passwordless-twitter-disable-id",
        username="passwordless-twitter-disable",
    )
    client = APIClient()
    client.force_authenticate(user=user)
    before = epoch_of(user)

    response = client.put(
        "/api/twitter/public-status/",
        {"is_public": False, "allow_login": False},
        format="json",
    )

    assert response.status_code == 409, response.content
    assert b"Set a password or reconnect another login method" in response.content
    profile.refresh_from_db()
    assert profile.allow_login is True
    assert epoch_of(user) == before


def test_a_second_concurrent_twitter_delete_counts_nothing(creator_factory):
    """The bump is gated on the DELETE's row count, not on a prior read.

    `get_object_or_404` proves the row existed when it was selected, not that
    this request removed it, so seventeen concurrent deletes would all have
    bumped for one revocation (codex adversarial review). Serialised here, but
    it is the same code path: the second call finds nothing to delete.
    """
    from dj.apps.twitter.models import TwitterProfile

    user = creator_factory()
    TwitterProfile.objects.create(
        creator=user, twitter_id="tw-9", username="tw_nine",
    )
    client = APIClient()
    client.force_authenticate(user=user)
    before = epoch_of(user)

    first = client.delete("/api/twitter/delete")
    assert first.status_code == 204, first.content
    assert epoch_of(user) == before + 1

    second = client.delete("/api/twitter/delete")
    assert second.status_code == 404, second.content
    assert epoch_of(user) == before + 1


def test_deleting_a_confirmed_recovery_address_is_an_ownership_event(
    creator_factory,
):
    """A deletion revokes as surely as a replacement (codex adversarial review)."""
    user = creator_factory()
    confirmed_email(user, "delete-me@example.com")
    client = APIClient()
    client.force_authenticate(user=user)
    before = epoch_of(user)

    response = client.delete("/api/emails/delete")

    assert response.status_code == 204, response.content
    assert epoch_of(user) == before + 1


def test_deleting_an_unconfirmed_address_is_not_an_ownership_event(
    creator_factory,
):
    """It was never a recovery principal, so nothing was revoked."""
    user = creator_factory()
    Email.objects.create(
        user=user,
        email="pending-delete@example.com",
        token="email-token",
        expires_at=timezone.now() + timedelta(hours=1),
    )
    client = APIClient()
    client.force_authenticate(user=user)
    before = epoch_of(user)

    response = client.delete("/api/emails/delete")

    assert response.status_code == 204, response.content
    assert epoch_of(user) == before


def test_the_email_admin_only_counts_a_confirmed_address(creator_factory):
    """`grants_access` is what keeps an unconfirmed row outside the count."""
    from django.contrib.admin.sites import AdminSite

    from dj.apps.emails.admin import EmailAdmin

    confirmed_user, pending_user = creator_factory(), creator_factory()
    confirmed = confirmed_email(confirmed_user, "admin-confirmed@example.com")
    pending = Email.objects.create(
        user=pending_user,
        email="admin-pending@example.com",
        token="email-token",
        expires_at=timezone.now() + timedelta(hours=1),
    )
    before = epoch_of(confirmed_user), epoch_of(pending_user)

    site = EmailAdmin(Email, AdminSite())
    site.delete_model(request=None, obj=confirmed)
    site.delete_model(request=None, obj=pending)

    assert epoch_of(confirmed_user) == before[0] + 1
    assert epoch_of(pending_user) == before[1]


def test_staff_deleting_a_credential_in_the_admin_counts(creator_factory):
    """The back door to every route above (codex adversarial review)."""
    from django.contrib.admin.sites import AdminSite

    from dj.apps.twitter.admin import TwitterProfileAdmin
    from dj.apps.twitter.models import TwitterProfile

    user = creator_factory()
    profile = TwitterProfile.objects.create(
        creator=user, twitter_id="tw-3", username="tw_three",
    )
    before = epoch_of(user)

    site = TwitterProfileAdmin(TwitterProfile, AdminSite())
    site.delete_model(request=None, obj=profile)

    assert not TwitterProfile.objects.filter(pk=profile.pk).exists()
    assert epoch_of(user) == before + 1


def test_the_admin_bulk_delete_action_counts_too(creator_factory):
    """`delete_queryset` is the changelist action, and it skips `delete_model`."""
    from django.contrib.admin.sites import AdminSite

    from dj.apps.twitter.admin import TwitterProfileAdmin
    from dj.apps.twitter.models import TwitterProfile

    one, two = creator_factory(), creator_factory()
    TwitterProfile.objects.create(
        creator=one, twitter_id="tw-4", username="tw_four",
    )
    TwitterProfile.objects.create(
        creator=two, twitter_id="tw-5", username="tw_five",
    )
    # An ORPHAN credential: `TwitterProfile.creator` is null=True, so a row
    # with no owner is a real state, and it puts None into `revoked_from`
    # alongside real ids. The first draft sorted that mixed set and raised
    # TypeError AFTER the rows were deleted -- admin 500, epoch unmoved,
    # tokens still valid: precisely the failure this module exists to prevent.
    TwitterProfile.objects.create(creator=None, twitter_id="tw-orphan")

    before = epoch_of(one), epoch_of(two)

    site = TwitterProfileAdmin(TwitterProfile, AdminSite())
    site.delete_queryset(
        request=None, queryset=TwitterProfile.objects.all()
    )

    assert (epoch_of(one), epoch_of(two)) == (before[0] + 1, before[1] + 1)
    assert not TwitterProfile.objects.exists()


def test_the_bulk_delete_still_deletes_rows_that_grant_nobody_access(
    creator_factory,
):
    """The delete is unconditional; only the BUMP is conditional.

    An earlier draft of `delete_queryset` returned early when no selected row
    granted access -- skipping `super().delete_queryset()` itself. Django's
    bulk action still reported success, so staff removing a suspicious PENDING
    email address during a remediation were told it was gone while the row, and
    its usable confirmation token, stayed put until expiry. `EmailAdmin.
    grants_access` returns False for every unconfirmed address, so this is not
    a corner: it is the whole unconfirmed population.

    `TwitterProfile` cannot catch this -- its rows always grant access -- which
    is exactly why the codex adversarial review found it and the existing test
    did not.
    """
    from dj.apps.emails.admin import EmailAdmin

    user = creator_factory()
    Email.objects.create(
        user=user,
        email="pending@example.com",
        token="pending-token",
        confirmed_at=None,
        expires_at=timezone.now() + timedelta(days=1),
    )
    before = epoch_of(user)

    site = EmailAdmin(Email, AdminSite())
    site.delete_queryset(request=None, queryset=Email.objects.all())

    assert not Email.objects.exists(), (
        "an unconfirmed address grants no access, but the admin still has to "
        "actually delete it"
    )
    #...and it is still not an ownership event: nothing was revoked.
    assert epoch_of(user) == before


def test_reassigning_a_credential_counts_the_losing_account_only(
    creator_factory,
):
    """Reassignment revokes from one account and adds to another.

    Only the revocation half counts -- the gaining account merely acquired a
    principal, and counting that would spend A18b budget for nothing. Corrected
    from a first draft that counted both (codex adversarial review).
    """
    from django.contrib.admin.sites import AdminSite

    from dj.apps.twitter.admin import TwitterProfileAdmin
    from dj.apps.twitter.models import TwitterProfile

    old_owner, new_owner = creator_factory(), creator_factory()
    profile = TwitterProfile.objects.create(
        creator=old_owner, twitter_id="tw-6", username="tw_six",
    )
    before = epoch_of(old_owner), epoch_of(new_owner)

    class _Form:
        changed_data = ["creator"]

    profile.creator = new_owner
    TwitterProfileAdmin(TwitterProfile, AdminSite()).save_model(
        request=None, obj=profile, form=_Form(), change=True
    )

    assert epoch_of(old_owner) == before[0] + 1
    assert epoch_of(new_owner) == before[1]


def test_the_admin_switch_counts_by_direction_not_by_membership(
    creator_factory,
):
    """Disabling a login revokes; re-enabling it only adds.

    Without this a staff repair cycle spends two epochs where the HTTP route
    spends one, and crosses A18b in half the events (codex adversarial review).
    """
    from django.contrib.admin.sites import AdminSite

    from dj.apps.twitter.admin import TwitterProfileAdmin
    from dj.apps.twitter.models import TwitterProfile

    user = creator_factory()
    profile = TwitterProfile.objects.create(
        creator=user, twitter_id="tw-8", username="tw_eight", allow_login=True,
    )
    site = TwitterProfileAdmin(TwitterProfile, AdminSite())
    before = epoch_of(user)

    class _Form:
        changed_data = ["allow_login"]

    profile.allow_login = False
    site.save_model(request=None, obj=profile, form=_Form(), change=True)
    assert epoch_of(user) == before + 1

    profile.allow_login = True
    site.save_model(request=None, obj=profile, form=_Form(), change=True)
    assert epoch_of(user) == before + 1


def test_an_admin_display_only_edit_counts_for_nobody(creator_factory):
    """The mixin must not count a cosmetic edit -- that is A18b budget."""
    from django.contrib.admin.sites import AdminSite

    from dj.apps.twitter.admin import TwitterProfileAdmin
    from dj.apps.twitter.models import TwitterProfile

    user = creator_factory()
    profile = TwitterProfile.objects.create(
        creator=user, twitter_id="tw-7", username="tw_seven",
    )
    before = epoch_of(user)

    class _Form:
        changed_data = ["name"]

    profile.name = "Renamed By Staff"
    TwitterProfileAdmin(TwitterProfile, AdminSite()).save_model(
        request=None, obj=profile, form=_Form(), change=True
    )

    assert epoch_of(user) == before


def test_the_changepassword_override_is_the_one_django_resolves():
    """The override is inert unless `ktauth` sits FIRST in INSTALLED_APPS.

    `get_commands()` iterates `reversed(apps.get_app_configs())`, so the
    EARLIEST app wins -- the opposite of the intuition, and a mistake that
    leaves the file installed, importable and doing nothing.
    """
    from django.core.management import get_commands

    assert get_commands()["changepassword"] == "dj.apps.ktauth"


def test_the_changepassword_command_counts(creator_factory, mocker):
    """`manage.py changepassword` is the path an operator reaches for."""
    from django.core.management import call_command

    user = creator_factory(username="cliuser", password="old-password")
    before = epoch_of(user)

    mocker.patch(
        "django.contrib.auth.management.commands.changepassword."
        "Command._get_pass",
        return_value="a-long-enough-cli-password",
    )
    call_command("changepassword", "cliuser", verbosity=0)

    assert Creator.objects.get(pk=user.pk).check_password(
        "a-long-enough-cli-password"
    )
    assert epoch_of(user) == before + 1


# ---------------------------------------------------- deliberate non-events


def test_a_profile_update_is_not_an_ownership_event(creator_factory):
    """PATCH /api/auth/user/ -- the bare-``save()`` path of /.

    It must neither increment the counter nor write the old value back over an
    increment that landed while the request was in flight.
    """
    user = creator_factory()
    client = APIClient()
    client.force_authenticate(user=user)
    before = epoch_of(user)

    response = client.patch(
        "/api/auth/user/", {"full_name": "Renamed"}, format="json"
    )

    assert response.status_code == 200, response.content
    assert epoch_of(user) == before


def test_a_new_account_starts_at_the_baseline(creator_factory):
    """There is no predecessor to invalidate, so nothing has to be counted."""
    assert epoch_of(creator_factory()) == INITIAL_ACCOUNT_EPOCH


def test_every_declared_ownership_event_marks_passwordless_fallbacks(
    creator_factory, monkeypatch, settings,
):
    """No event constant can bypass the shared fallback-marking boundary."""
    from dj.apps.ktauth import credentials, epoch
    from dj.apps.social.models import SocialIdentity

    settings.GOOGLE_CLIENT_ID = "test-google-id"
    settings.GOOGLE_CLIENT_SECRET = "test-google-secret"
    settings.ZUULI_SOCIAL_AUTH_ENABLED = True
    owner = creator_factory(username="all-events-mark-fallbacks")
    owner.set_unusable_password()
    owner.save(update_fields=["password", "password_set", "updated_at"])
    older = SocialIdentity.objects.create(
        creator=owner,
        provider="google",
        provider_uid="all-events-older",
        linked_at_epoch=1,
    )
    newer = SocialIdentity.objects.create(
        creator=owner,
        provider="google",
        provider_uid="all-events-newer",
        linked_at_epoch=1,
    )
    SocialIdentity.objects.filter(pk=older.pk).update(
        verified_at=timezone.now() - timedelta(days=2),
    )
    SocialIdentity.objects.filter(pk=newer.pk).update(
        verified_at=timezone.now() - timedelta(days=1),
    )
    calls = []
    original = credentials.mark_passwordless_fallbacks

    def record_call(user_id, current_epoch, using=None):
        marked = original(user_id, current_epoch, using=using)
        calls.append((user_id, current_epoch, marked))
        return marked

    monkeypatch.setattr(credentials, "mark_passwordless_fallbacks", record_call)
    for event in sorted(epoch.OWNERSHIP_EVENTS):
        epoch.bump_account_epoch(owner.pk, event=event)

    assert len(calls) == len(epoch.OWNERSHIP_EVENTS)
    assert {user_id for user_id, _, _ in calls} == {owner.pk}
    assert calls[0][2] == 1
    assert all(marked == 0 for _, _, marked in calls[1:])
    older.refresh_from_db()
    newer.refresh_from_db()
    assert older.fallback_rejected_at_epoch is None
    assert newer.fallback_rejected_at_epoch == 2
