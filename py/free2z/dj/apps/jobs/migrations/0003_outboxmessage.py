"""The Pub/Sub transactional outbox table (#788).

A new empty table with two partial indexes: no rewrite, no lock on anything
that serves traffic, and nothing to backfill. The producers start writing
rows the moment the new image is serving; until the worker image carrying
``jobs.publish_outbox`` is also up, rows simply accumulate and the periodic
sweep drains them (which is exactly the durability property the table exists
for, exercised on day one).

``dedup_key`` ships in THIS migration rather than a follow-up (#1686 point
4). It is unused by the two producers moved here, but #1691 needs it, and the
epic's migration order allows the ``jobs`` app exactly one leaf at a time --
adding the column later would cost a second slot in that queue for a
zero-row ``ALTER TABLE ... ADD COLUMN`` on a table that is empty today.

``initial`` is deliberately NOT set: the app already has 0001/0002, and
marking this initial would make ``migrate --fake-initial`` eligible to skip
it against a database where the table happens to exist under a different
shape.
"""
import django.utils.timezone
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('jobs', '0002_procrastinate_multilingual_lookup_index'),
    ]

    operations = [
        migrations.CreateModel(
            name='OutboxMessage',
            fields=[
                ('id', models.BigAutoField(
                    auto_created=True, primary_key=True, serialize=False,
                    verbose_name='ID')),
                ('topic', models.TextField()),
                ('payload', models.JSONField()),
                ('attributes', models.JSONField(blank=True, default=dict)),
                ('ordering_key', models.CharField(
                    blank=True, default='', max_length=255)),
                ('ensure_topic', models.BooleanField(default=False)),
                ('created_at', models.DateTimeField(
                    default=django.utils.timezone.now)),
                ('published_at', models.DateTimeField(blank=True, null=True)),
                ('attempts', models.PositiveIntegerField(default=0)),
                ('next_attempt_at', models.DateTimeField(
                    default=django.utils.timezone.now)),
                ('last_error', models.TextField(blank=True, default='')),
                ('dedup_key', models.CharField(
                    blank=True, default=None, max_length=255, null=True,
                    unique=True)),
            ],
            options={
                'db_table': 'jobs_outbox_message',
                'indexes': [
                    models.Index(
                        condition=models.Q(('published_at__isnull', True)),
                        fields=['next_attempt_at', 'id'],
                        name='jobs_outbox_due_idx'),
                    models.Index(
                        condition=models.Q(('published_at__isnull', True)),
                        fields=['ordering_key', 'id'],
                        name='jobs_outbox_ordering_idx'),
                ],
            },
        ),
    ]
