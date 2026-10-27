"""The job-lease table (#1687).

WHAT THIS UNBLOCKS
------------------
``dj.apps.jobs.lease`` -- the task middleware merged as #1727 -- is
WRITTEN against this table, but the table has never been in the migration
graph. That has cost nothing so far, because the middleware does not
reach the table at all: ``acquire()`` returns ``None`` at the
``enabled()`` gate BEFORE the ``to_regclass`` probe below it, and the
gate is shut -- ``reclaim.READS_LEASES`` does not exist until #1689, and
``JOB_LEASE_WITHOUT_RECLAIMER`` defaults to false and is set nowhere in
``k8s/``. So what production logs once per process today is
``event=procrastinate_lease_disabled reason=reclaimer_not_lease_aware``,
NOT ``reason=table_missing`` (which no deployed configuration can reach),
and every job runs unleased.

THIS MIGRATION THEREFORE CHANGES NOTHING AT RUNTIME. No lease row is
written, no beat is sent; ``SELECT count(*) FROM jobs_joblease`` is 0
after the deploy and stays 0. ``test_lease.py``'s
``test_leases_are_inert_until_the_reclaimer_reads_them`` is the check
that says so. What the migration removes is a PRECONDITION: when #1689
flips ``reclaim.READS_LEASES``, the gate lifts and the middleware finds
the table already there, instead of hitting the missing-table path
(``reason=table_missing``) and running every job unleased until the
table appears. That path is NOT permanent: ``_TableProbe`` re-probes
every ``JOB_LEASE_TABLE_RECHECK_SECONDS`` (default 60s), opening no
connection in between, and a running worker picks the table up on its
next probe WITHOUT a restart -- so a ``table_missing`` line is never a
reason to roll the worker Deployment (which kills in-flight jobs). Landing
the table one PR ahead of the reclaimer is simply the order the epic
(#1684) asks for: the reclaimer should never see a window, however short,
in which its leases cannot be written.

**An empty table is the correct post-deploy state -- do NOT reach for
``JOB_LEASE_WITHOUT_RECLAIMER=true`` to make rows appear.** That flag
lifts the gate with no reclaimer behind it, which arms the fences: a
fenced run raises ``LeaseLost``, the worker writes no status at all, and
the job sits in ``doing`` until the 3600s ``job_stuck`` path finds it.
It is an operator escape hatch for someone who has read
``lease.py``'s "BEFORE THE RECLAIMER READS LEASES" section, not a
remedy for a lease table that is empty on purpose.

A new empty table: no rewrite, no backfill, and no lock on anything that
serves traffic. It takes no foreign key into ``procrastinate_jobs`` (see
the model docstring: a lease is allowed to outlive the row it names, and a
FK would lock the queue table on every lease INSERT).

THE SCHEMA IS PINNED TO ``lease.LEASE_TABLE_DDL``
------------------------------------------------
The middleware's SQL was written against that constant, and until this
migration existed ``test_lease.py`` created the table from it directly. The
two must agree column for column, DEFAULT for DEFAULT, index for index, and
``test_lease_migration.py`` parses BOTH and fails on any drift in either
direction. The DB-level defaults are therefore ``db_default`` (kept in the
column) rather than ``default`` (Python-side, dropped from the column by
design), and ``attempt`` is a plain ``IntegerField`` because
``PositiveIntegerField`` would add a CHECK constraint the DDL has not got.

The index is named EXPLICITLY. Django would otherwise hash a name out of
the table and columns, and ``jobs_joblease_last_beat_at_idx`` is the name
the DDL, #1689's sweep and anybody reading EXPLAIN output use.

``initial`` is deliberately NOT set: the app already has 0001-0003, and
marking this initial would make ``migrate --fake-initial`` eligible to skip
it against a database where the table happens to exist under a different
shape -- which is precisely the database this migration is aimed at, since
``LEASE_TABLE_DDL`` is a ``CREATE TABLE IF NOT EXISTS`` that a test or an
operator may already have run.

AND IF THE TABLE IS ALREADY THERE, THIS MIGRATION FAILS LOUDLY, ON PURPOSE
(codex's riskiest line). ``migrate`` is a Cloud Build step the APPLY waits
on, so a ``DuplicateTable`` here aborts the whole production deploy. That is
still the outcome we want: nothing in the repository creates this table
outside a test database (``lease.py`` only ever probes for it with
``to_regclass``), so a table that exists in production was created by hand,
of unknown shape, and silently adopting it -- ``SeparateDatabaseAndState``
around a ``CREATE TABLE IF NOT EXISTS``, or ``--fake`` -- would leave the
middleware writing against columns nobody has checked, which is the exact
failure ``test_lease_migration.py`` exists to prevent. The operator remedy
is one line, and it is safe because the table holds only in-flight leases
that any restart recreates: ``DROP TABLE jobs_joblease;`` then re-run
``migrate``.
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('jobs', '0003_outboxmessage'),
    ]

    operations = [
        migrations.CreateModel(
            name='JobLease',
            fields=[
                ('job_id', models.BigIntegerField(
                    primary_key=True, serialize=False)),
                ('token', models.UUIDField()),
                ('worker_name', models.CharField(
                    blank=True, db_default='', default='', max_length=255)),
                ('pod', models.CharField(
                    blank=True, db_default='', default='', max_length=255)),
                ('task_name', models.CharField(max_length=255)),
                ('queue', models.CharField(max_length=255)),
                ('started_at', models.DateTimeField()),
                ('last_beat_at', models.DateTimeField()),
                ('deadline_at', models.DateTimeField(blank=True, null=True)),
                ('attempt', models.IntegerField(db_default=0, default=0)),
            ],
            options={
                'db_table': 'jobs_joblease',
                'indexes': [
                    models.Index(
                        fields=['last_beat_at'],
                        name='jobs_joblease_last_beat_at_idx'),
                ],
            },
        ),
    ]
