"""Stamp every bearer token with the account epoch it was minted against.

The table is #1570's use-time revocation surface; see
``dj/apps/g12f/models/credentials.py`` for why a sweep cannot close that race
and a stamp can.

**The backfill is not optional.** Authentication refuses a token that has no
stamp — deliberately, because "no stamp" must not be interpreted as "valid"
(the #1389 lesson). Shipping the table empty would therefore 401 every Knox
token in existence the moment the code deploys: every ZUULI session, every
third-party API client, every mobile app. So each live token is stamped at its
account's CURRENT epoch.

**That is a trade, not a free win, and the codex adversarial review was right
to name it.** A token that survived a past ownership event through the #1570
race is indistinguishable, from the row alone, from one minted legitimately
after that event: #1569 deletes every token on every event, so ANY token that
exists was created after the account's last bump, by a re-login or by the race.
Stamping them current therefore blesses any race survivor that happens to be
outstanding. It is taken anyway because the alternative is not "fail closed for
the attacker", it is **fail closed for everybody** — every Knox token on the
platform 401s at deploy: every mobile session, every ZUULI client, every
third-party integration, at once, with no way to tell them apart from the one
hypothetical survivor. The race needs an attacker to be mid-login at the
instant of a revocation; the outage needs only a deploy.

Note this is the OPPOSITE call from the sibling migrations for
``Email.token_epoch`` and ``linked_at_epoch``, and deliberately so: those fail
closed because their blast radius is "click resend" and "click reconnect",
while this one's is a platform-wide loss of API access. Where the recovery is
cheap, refuse; where it is an outage, admit and say so.
"""

import django.db.models.deletion
from django.db import migrations, models


def stamp_existing_tokens(apps, schema_editor):
    AuthToken = apps.get_model('knox', 'AuthToken')
    IssuedTokenEpoch = apps.get_model('g12f', 'IssuedTokenEpoch')
    db = schema_editor.connection.alias

    # `iterator()` with a bounded chunk: this runs inside the deploy's
    # `manage.py migrate` step, which the APPLY stage waits on, and the token
    # table is one row per live sign-in across the platform. Materialising it
    # would be a memory spike on the smallest pod in the release.
    rows = (
        AuthToken.objects.using(db)
        .values_list('digest', 'user__kt_account_epoch')
        .iterator(chunk_size=2000)
    )
    batch = []
    for digest, account_epoch in rows:
        batch.append(
            IssuedTokenEpoch(
                token_id=digest,
                # A token whose user row somehow carries NULL/0 gets the
                # initial epoch rather than being left unstamped: unstamped is
                # a refusal, and a data anomaly must not sign anybody out.
                account_epoch=account_epoch or 1,
            )
        )
        if len(batch) >= 2000:
            IssuedTokenEpoch.objects.using(db).bulk_create(
                batch, ignore_conflicts=True,
            )
            batch = []
    if batch:
        IssuedTokenEpoch.objects.using(db).bulk_create(
            batch, ignore_conflicts=True,
        )


def drop_stamps(apps, schema_editor):
    """Reverse is a no-op beyond the table drop the schema step does."""


class Migration(migrations.Migration):

    dependencies = [
        ('g12f', '0106_zpage_searchable_content_updated_at'),
        ('knox', '0008_remove_authtoken_salt'),
    ]

    operations = [
        migrations.CreateModel(
            name='IssuedTokenEpoch',
            fields=[
                ('token', models.OneToOneField(help_text='The bearer token this stamp belongs to.', on_delete=django.db.models.deletion.CASCADE, primary_key=True, related_name='account_epoch_stamp', serialize=False, to='knox.authtoken')),
                ('account_epoch', models.PositiveIntegerField(editable=False, help_text='Creator.kt_account_epoch as read in the same snapshot that validated the credential this token was issued for. Authentication refuses the token when the account has moved on.')),
            ],
            options={
                'verbose_name': 'Issued token epoch',
                'verbose_name_plural': 'Issued token epochs',
            },
        ),
        migrations.RunPython(stamp_existing_tokens, drop_stamps),
    ]
