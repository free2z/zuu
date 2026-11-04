import django.db.models.deletion
import django.db.models.functions.text
from django.conf import settings
from django.db import migrations, models

LOCK_TIMEOUT = '5s'


def bound_lock_wait(apps, schema_editor):
    """The foreign key takes SHARE ROW EXCLUSIVE on g12f_creator.

    Bound the wait for it, so a long-running account writer makes this
    migration fail fast (re-run the deploy) instead of queueing every account
    write behind it (codex adversarial review).
    """
    if schema_editor.connection.vendor != 'postgresql':
        return
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'")


class HandlesTableNotEmpty(RuntimeError):
    pass


def refuse_to_drop_bindings(apps, schema_editor):
    """Reverse only: never drop a table that holds bindings.

    Runs before ``DeleteModel`` (operations reverse in reverse order), after
    the lock timeout is set. A binding may already be published in the
    key-transparency log; dropping it and re-applying would hand its handle to
    whoever's username folds to it next. Emptying the table is a deliberate,
    manual step (``docs/e2ee/handles.md``), never a side effect of a rollback.
    """
    bound_lock_wait(apps, schema_editor)
    MessagingHandle = apps.get_model('handles', 'MessagingHandle')
    if MessagingHandle._default_manager.using(
        schema_editor.connection.alias
    ).exists():
        raise HandlesTableNotEmpty(
            'handles_messaginghandle is not empty; refusing to drop messaging '
            'handle bindings on rollback. See docs/e2ee/handles.md.'
        )


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.RunPython(bound_lock_wait, migrations.RunPython.noop),
        migrations.CreateModel(
            name='MessagingHandle',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('handle', models.CharField(editable=False, help_text='^[a-z0-9_]{1,30}$, ASCII. Permanent once bound.', max_length=30)),
                ('status', models.CharField(choices=[('bound', 'Bound'), ('retired', 'Retired')], default='bound', max_length=16)),
                ('source', models.CharField(choices=[('username', 'Reserved from username'), ('claimed', 'Claimed')], editable=False, max_length=16)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('user', models.OneToOneField(editable=False, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='messaging_handle', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'verbose_name': 'messaging handle',
                'constraints': [
                    models.UniqueConstraint(django.db.models.functions.text.Lower('handle'), name='messaging_handle_ci_unique', violation_error_message='This messaging handle is taken.'),
                    models.CheckConstraint(condition=models.Q(('handle__regex', '^[a-z0-9_]{1,30}$')), name='messaging_handle_charset', violation_error_message='A messaging handle is 1-30 characters of a-z, 0-9 and _.'),
                    models.CheckConstraint(condition=models.Q(models.Q(('status', 'bound'), _negated=True), ('user__isnull', False), _connector='OR'), name='messaging_handle_bound_has_user'),
                ],
            },
        ),
        # Last, so on reverse it runs FIRST: timeout, then the emptiness
        # check, then the drop.
        migrations.RunPython(
            migrations.RunPython.noop, refuse_to_drop_bindings
        ),
    ]
