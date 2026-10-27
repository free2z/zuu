"""Widen and relax the language columns (#980 M1, step 1 of 4).

**This migration is the blocking prerequisite for language detection.** Both
language columns are ``varchar(10)`` with a four-value ``choices`` list. The
registry in ``f2z/languages.py`` normalizes to 35 characters and the detector
in ``f2z/ai/language.py`` legitimately returns wider tags — ``yue-Hant-HK`` is
11, ``ca-ES-valencia`` is 14. Persisting a correct detection into a
``varchar(10)`` raises ``DataError`` on INSERT. Two agents found this
independently; it is why this migration is first.

Three changes, all of them metadata-only in PostgreSQL — no table rewrite, no
sequential scan, no index rebuild:

* ``varchar(10) -> varchar(35)``. Increasing the length of a ``varchar(n)`` has
  been catalog-only since PostgreSQL 9.2, precisely because the on-disk
  representation is identical.
* ``DROP NOT NULL`` on ``g12f_zpage.source_language``. NULL is #980 §3.2's
  honest representation of "detection has not run yet". **Nothing writes NULL
  in this wave** — the model default and the ``DEFAULT 'und'`` installed by
  0088 are both untouched — so behavior on both sides of this deploy, and after
  a rollback, is identical. Dropping the constraint now means the detection
  wave does not have to take a second exclusive lock on the largest table.
* Dropping ``choices``. State-only: Postgres never knew about the enum, it only
  drove the admin widget and ``get_FOO_display()``. Keeping it would mean a
  migration every time we add a language, which is how a closed enum grows back.

Rolling-deploy safety: old pods keep writing ``und`` and four-locale tags, all
of which still fit and are still valid. New pods write wider tags, which old
pods only ever read back and echo. Nothing in the old code inspects the column
width.

**Reverse is deliberately not symmetric.** Un-widening to ``varchar(10)`` would
truncate — Postgres refuses the ALTER outright if any row is too long — and
re-adding NOT NULL would fail on any NULL a later wave wrote. The reverse
restores the *state* only, via SeparateDatabaseAndState, so ``migrate g12f
0096`` unwinds Django's history without a destructive DDL. If a genuine rollback
of the column type is ever needed, do it deliberately after checking the data.
"""
from django.db import migrations, models


class Migration(migrations.Migration):
    # One short transaction. Both ALTERs take ACCESS EXCLUSIVE on their table,
    # but each is a catalog update measured in microseconds; the three-second
    # lock budget bounds how long we can be stuck *waiting* for the lock behind
    # a long-running reader. If it expires, the whole migration rolls back and
    # the next deploy retries cleanly.
    dependencies = [("g12f", "0096_alter_creator_total")]

    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout = '3s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunSQL(
                    "ALTER TABLE g12f_zpage "
                    "ALTER COLUMN source_language TYPE varchar(35), "
                    "ALTER COLUMN source_language DROP NOT NULL;",
                    reverse_sql=migrations.RunSQL.noop,
                ),
                migrations.RunSQL(
                    "ALTER TABLE g12f_zpagetranslation "
                    "ALTER COLUMN language TYPE varchar(35);",
                    reverse_sql=migrations.RunSQL.noop,
                ),
            ],
            state_operations=[
                migrations.AlterField(
                    model_name="zpage",
                    name="source_language",
                    field=models.CharField(
                        blank=True,
                        db_default="und",
                        db_index=True,
                        default="und",
                        help_text=(
                            "Language of the canonical title, description "
                            "and content."
                        ),
                        max_length=35,
                        null=True,
                    ),
                ),
                migrations.AlterField(
                    model_name="zpagetranslation",
                    name="language",
                    field=models.CharField(max_length=35),
                ),
            ],
        ),
    ]
