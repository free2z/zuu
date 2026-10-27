"""Regression coverage for the legacy passwordless fallback data migration."""

import importlib

import pytest
from django.apps import apps
from django.db import connection
from django.test import override_settings
from django.utils import timezone

from dj.apps.social.models import SocialIdentity
from dj.apps.twitter.models import TwitterProfile
from dj.apps.zauth.models import ZcashIdentity


@pytest.mark.django_db
@override_settings(
    GOOGLE_CLIENT_ID="",
    GOOGLE_CLIENT_SECRET="",
    GITHUB_CLIENT_ID="",
    GITHUB_CLIENT_SECRET="",
    IDENTITY_PASSKEY_SIGNIN_ENABLED=False,
    WEBAUTHN_RP_ID="",
    TWITTER_CLIENT_ID="",
    TWITTER_CLIENT_SECRET="",
)
def test_legacy_multi_identity_account_gets_one_stale_fallback(creator_factory):
    owner = creator_factory(username="legacy-fallback-backfill")
    owner.set_unusable_password()
    owner.kt_account_epoch = 2
    owner.save(update_fields=["password", "password_set", "kt_account_epoch"])

    older = SocialIdentity.objects.create(
        creator=owner,
        provider="google",
        provider_uid="legacy-fallback-older",
        linked_at_epoch=1,
    )
    newer = SocialIdentity.objects.create(
        creator=owner,
        provider="google",
        provider_uid="legacy-fallback-newer",
        linked_at_epoch=1,
    )
    now = timezone.now()
    SocialIdentity.objects.filter(pk=older.pk).update(
        verified_at=now - timezone.timedelta(days=30),
    )
    SocialIdentity.objects.filter(pk=newer.pk).update(
        verified_at=now - timezone.timedelta(days=10),
    )

    migration = importlib.import_module(
        "dj.apps.identity.migrations.0003_backfill_passwordless_identity_fallbacks"
    )
    with connection.schema_editor() as schema_editor:
        migration.backfill_passwordless_fallbacks(apps, schema_editor)

    older.refresh_from_db()
    newer.refresh_from_db()
    assert older.fallback_rejected_at_epoch is None
    assert newer.fallback_rejected_at_epoch == 2


@pytest.mark.django_db
@override_settings(
    GOOGLE_CLIENT_ID="",
    GOOGLE_CLIENT_SECRET="",
    GITHUB_CLIENT_ID="",
    GITHUB_CLIENT_SECRET="",
    IDENTITY_PASSKEY_SIGNIN_ENABLED=False,
    WEBAUTHN_RP_ID="",
    TWITTER_CLIENT_ID="",
    TWITTER_CLIENT_SECRET="",
)
def test_legacy_backfill_does_not_trust_a_current_epoch_link_over_the_original(
    creator_factory,
):
    """A current-epoch link is not ownership evidence ( threat model).

    The current-epoch row may have been planted from a stolen recent session.
    The backfill must rank stale rows exactly like a runtime ownership event:
    it must not reject the owner's original login because a newer row exists,
    and the owner's original must still win the NEXT event against the plant.
    """
    from dj.apps.ktauth import epoch

    owner = creator_factory(username="legacy-fallback-relinked")
    owner.set_unusable_password()
    owner.kt_account_epoch = 3
    owner.save(update_fields=["password", "password_set", "kt_account_epoch"])

    stale = SocialIdentity.objects.create(
        creator=owner,
        provider="google",
        provider_uid="legacy-fallback-stale",
        linked_at_epoch=1,
    )
    current = SocialIdentity.objects.create(
        creator=owner,
        provider="google",
        provider_uid="legacy-fallback-current",
        linked_at_epoch=3,
    )
    SocialIdentity.objects.filter(pk=stale.pk).update(
        verified_at=timezone.now() - timezone.timedelta(days=30),
    )

    migration = importlib.import_module(
        "dj.apps.identity.migrations.0003_backfill_passwordless_identity_fallbacks"
    )
    with connection.schema_editor() as schema_editor:
        migration.backfill_passwordless_fallbacks(apps, schema_editor)

    stale.refresh_from_db()
    current.refresh_from_db()
    assert stale.fallback_rejected_at_epoch is None
    assert current.fallback_rejected_at_epoch is None

    with override_settings(
        GOOGLE_CLIENT_ID="test-google-id", GOOGLE_CLIENT_SECRET="test-google-secret",
    ):
        epoch.bump_account_epoch(owner.pk, event=epoch.EVENT_CREDENTIAL_ADMIN_EDIT)
    stale.refresh_from_db()
    current.refresh_from_db()
    assert stale.fallback_rejected_at_epoch is None
    assert current.fallback_rejected_at_epoch == 4


@pytest.mark.django_db
@override_settings(
    GOOGLE_CLIENT_ID="",
    GOOGLE_CLIENT_SECRET="",
    GITHUB_CLIENT_ID="",
    GITHUB_CLIENT_SECRET="",
    IDENTITY_PASSKEY_SIGNIN_ENABLED=False,
    WEBAUTHN_RP_ID="",
    TWITTER_CLIENT_ID="",
    TWITTER_CLIENT_SECRET="",
)
def test_empty_deploy_oauth_settings_do_not_reject_stored_social_identity(
    creator_factory,
):
    """The migration environment has no pod OAuth secrets."""
    owner = creator_factory(username="legacy-empty-oauth-backfill")
    owner.set_unusable_password()
    owner.kt_account_epoch = 2
    owner.save(update_fields=["password", "password_set", "kt_account_epoch"])

    social = SocialIdentity.objects.create(
        creator=owner,
        provider="google",
        provider_uid="legacy-empty-oauth-google",
        linked_at_epoch=1,
    )
    disabled_x = TwitterProfile.objects.create(
        creator=owner,
        twitter_id="legacy-empty-oauth-x",
        username="legacy_empty_oauth_x",
        allow_login=False,
        linked_at_epoch=1,
    )

    migration = importlib.import_module(
        "dj.apps.identity.migrations.0003_backfill_passwordless_identity_fallbacks"
    )
    with connection.schema_editor() as schema_editor:
        migration.backfill_passwordless_fallbacks(apps, schema_editor)

    social.refresh_from_db()
    disabled_x.refresh_from_db()
    assert social.fallback_rejected_at_epoch is None
    assert disabled_x.fallback_rejected_at_epoch == 2


@pytest.mark.django_db
@override_settings(
    GOOGLE_CLIENT_ID="",
    GOOGLE_CLIENT_SECRET="",
    GITHUB_CLIENT_ID="",
    GITHUB_CLIENT_SECRET="",
    IDENTITY_PASSKEY_SIGNIN_ENABLED=False,
    WEBAUTHN_RP_ID="",
    TWITTER_CLIENT_ID="",
    TWITTER_CLIENT_SECRET="",
)
def test_migration_does_not_mark_when_no_identity_is_eligible(creator_factory):
    owner = creator_factory(username="legacy-no-eligible-backfill")
    owner.set_unusable_password()
    owner.kt_account_epoch = 2
    owner.save(update_fields=["password", "password_set", "kt_account_epoch"])

    disabled_x = TwitterProfile.objects.create(
        creator=owner,
        twitter_id="legacy-no-eligible-x",
        username="legacy_no_eligible_x",
        allow_login=False,
        linked_at_epoch=1,
    )

    migration = importlib.import_module(
        "dj.apps.identity.migrations.0003_backfill_passwordless_identity_fallbacks"
    )
    with connection.schema_editor() as schema_editor:
        migration.backfill_passwordless_fallbacks(apps, schema_editor)

    disabled_x.refresh_from_db()
    assert disabled_x.fallback_rejected_at_epoch is None


@pytest.mark.django_db
@override_settings(
    GOOGLE_CLIENT_ID="",
    GOOGLE_CLIENT_SECRET="",
    GITHUB_CLIENT_ID="",
    GITHUB_CLIENT_SECRET="",
    IDENTITY_PASSKEY_SIGNIN_ENABLED=False,
    WEBAUTHN_RP_ID="",
    TWITTER_CLIENT_ID="",
    TWITTER_CLIENT_SECRET="",
)
def test_empty_deploy_oauth_settings_keep_stored_zcash_fallback(creator_factory):
    owner = creator_factory(username="legacy-empty-oauth-zcash")
    owner.set_unusable_password()
    owner.kt_account_epoch = 2
    owner.save(update_fields=["password", "password_set", "kt_account_epoch"])

    zcash = ZcashIdentity.objects.create(
        creator=owner,
        zcash_address="t1WnCauSV6fbHzWBHtSrK2qvFRyU6J121nH",
        linked_at_epoch=1,
    )
    social = SocialIdentity.objects.create(
        creator=owner,
        provider="google",
        provider_uid="legacy-empty-oauth-zcash-google",
        linked_at_epoch=1,
    )
    now = timezone.now()
    ZcashIdentity.objects.filter(pk=zcash.pk).update(
        created_at=now - timezone.timedelta(days=30),
    )
    SocialIdentity.objects.filter(pk=social.pk).update(
        verified_at=now - timezone.timedelta(days=10),
    )

    migration = importlib.import_module(
        "dj.apps.identity.migrations.0003_backfill_passwordless_identity_fallbacks"
    )
    with connection.schema_editor() as schema_editor:
        migration.backfill_passwordless_fallbacks(apps, schema_editor)

    zcash.refresh_from_db()
    social.refresh_from_db()
    assert zcash.fallback_rejected_at_epoch is None
    assert social.fallback_rejected_at_epoch == 2
