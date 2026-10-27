"""Freeze passwordless fallback choice for identities already on the site.

Before #1860, an ownership event left linked identities stale but did not
record which one, if any, could continue signing in. Without this backfill a
passwordless account with several old identities would reach the new runtime
rule with several unmarked candidates and be refused on every provider. Keep
the oldest persisted social, enabled X, Zcash or passkey method as its one
fallback; mark other stale methods at the account's current epoch so unlinking
cannot promote them later. Provider configuration is unavailable to the
Cloud Build migration process and does not determine ownership.
"""

from django.contrib.auth.hashers import is_password_usable
from django.db import migrations


def backfill_passwordless_fallbacks(apps, schema_editor):
    Creator = apps.get_model("g12f", "Creator")
    SocialIdentity = apps.get_model("social", "SocialIdentity")
    TwitterProfile = apps.get_model("twitter", "TwitterProfile")
    ZcashIdentity = apps.get_model("zauth", "ZcashIdentity")
    WebAuthnCredential = apps.get_model("identity", "WebAuthnCredential")
    using = schema_editor.connection.alias

    providers = (
        (
            SocialIdentity,
            "verified_at",
            "provider_uid",
            lambda row: True,
        ),
        (
            TwitterProfile,
            "created_at",
            "twitter_id",
            lambda row: bool(row["allow_login"]),
        ),
        (
            ZcashIdentity,
            "created_at",
            "zcash_address",
            lambda row: True,
        ),
        (
            WebAuthnCredential,
            "created_at",
            "credential_id",
            lambda row: True,
        ),
    )

    for creator in (
        Creator.objects.using(using)
        .filter(kt_account_epoch__gt=1)
        .only("pk", "password", "kt_account_epoch")
        .iterator(chunk_size=500)
    ):
        if is_password_usable(creator.password):
            continue

        stale = []
        for order, (model, timestamp, identifier, is_usable) in enumerate(
            providers
        ):
            fields = [
                "pk",
                "linked_at_epoch",
                "fallback_rejected_at_epoch",
                timestamp,
                identifier,
            ]
            if model is TwitterProfile:
                fields.append("allow_login")
            rows = model.objects.using(using).filter(
                creator_id=creator.pk,
                linked_at_epoch__lte=creator.kt_account_epoch,
            ).values(*fields)
            for row in rows.iterator(chunk_size=500):
                usable = is_usable(row)
                if (
                    row["linked_at_epoch"] >= creator.kt_account_epoch
                    or row["fallback_rejected_at_epoch"] is not None
                ):
                    continue
                stale.append({
                    "model": model,
                    "pk": row["pk"],
                    "epoch": creator.kt_account_epoch,
                    "timestamp": row[timestamp],
                    "identifier": row[identifier],
                    "order": order,
                    "eligible": usable,
                })

        if not stale:
            continue
        # The oldest persisted social, enabled Twitter, Zcash, or passkey
        # identity is the only stale fallback -- the same rule an ownership
        # event applies at runtime. A current-epoch link is deliberately NOT
        # treated as ownership evidence that rejects every older row: it may
        # be an identity planted from a stolen recent session (the #1602
        # threat), and trusting it here would reject the owner's original
        # login and leave the plant as the sole survivor of the next event.
        # Current-epoch rows are not stale and stay usable either way.
        # Migration eligibility cannot depend on deploy settings, which are
        # absent from the Cloud Build migrate step.
        eligible = [row for row in stale if row["eligible"]]
        winner = min(
            eligible,
            key=lambda row: (
                row["timestamp"] is None,
                row["timestamp"],
                row["order"],
                row["identifier"],
                row["pk"],
            ),
        ) if eligible else None
        # An empty eligible set is not evidence that every stale method is
        # rejected. In particular, deploy-time provider settings are absent
        # from Cloud Build's migrate step; persisted identities themselves are
        # the evidence available to this data migration.
        if winner is None:
            continue
        if len(stale) < 2:
            # The only stale row is already the sole fallback.
            continue
        for row in stale:
            if row["pk"] == winner["pk"] and row[
                "model"
            ] is winner["model"]:
                continue
            row["model"].objects.using(using).filter(
                pk=row["pk"], fallback_rejected_at_epoch__isnull=True,
            ).update(fallback_rejected_at_epoch=row["epoch"])


class Migration(migrations.Migration):

    dependencies = [
        ("g12f", "0105_creator_kt_account_epoch"),
        ("identity", "0002_webauthncredential_fallback_rejected_at_epoch"),
        ("social", "0003_socialidentity_fallback_rejected_at_epoch"),
        ("twitter", "0008_twitterprofile_fallback_rejected_at_epoch"),
        ("zauth", "0004_zcashidentity_fallback_rejected_at_epoch"),
    ]

    operations = [
        migrations.RunPython(
            backfill_passwordless_fallbacks,
            reverse_code=migrations.RunPython.noop,
        ),
    ]
