"""Issue #1389 — the durable per-account key-transparency ownership counter.

``AddField`` with a constant default, which on PostgreSQL 11+ is a metadata-only
change: the default is recorded in ``pg_attribute`` and existing rows are read
through it rather than rewritten, so this does not take an exclusive lock on
``g12f_creator`` for the length of a table rewrite. There is no backfill step
because there is nothing to compute — every existing account starts at the same
baseline.

**What the backfill assumes, said out loud.** Starting every existing account at
1 is only safe while **no log anywhere retains an epoch minted by the previous,
clock-derived issuer** — a retained ~1.79e9 against a fresh 1 makes A15 refuse
every reset that account will ever ask for, and no migration here can reach the
log to repair it. The assumption holds today because the endpoint has never
issued anything: it refuses at preflight unless ``KT_AUTHORITY_SECRET_NAME`` is
set, and no manifest in this repository sets it (see
``dj/apps/ktauth/__init__.py``). If that were ever untrue for some deployment,
the log's retained state has to be rebuilt administratively; there is no
in-band translation, because A18a refuses the old values on their face. Raised
by the codex adversarial review.

**Why 1 and not 0.** Zero is kept out of the domain deliberately: ``dj.apps.ktauth.epoch.account_epoch_for``
refuses to issue on a zero, so a column that somehow ends up unpopulated (a hand
edit, a restore from a snapshot taken before this migration) produces a refusal
rather than a signed assertion carrying a value nobody counted.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('g12f', '0104_remove_zpage_publication_trigger'),
    ]

    operations = [
        migrations.AddField(
            model_name='creator',
            name='kt_account_epoch',
            field=models.PositiveIntegerField(
                default=1,
                editable=False,
                help_text=(
                    'Key-transparency account-ownership counter. Incremented '
                    'once per ownership event by dj.apps.ktauth.epoch; never '
                    'set by hand.'
                ),
            ),
        ),
    ]
