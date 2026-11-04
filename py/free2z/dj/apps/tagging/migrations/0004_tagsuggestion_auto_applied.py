# State-only: a new choice on an existing CharField(max_length=16). Django
# records choices in migration state but emits no SQL for them, so this is
# safe to apply ahead of, or behind, the code that writes the value (#2194).

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tagging', '0003_tag_identity_and_alias_slug'),
    ]

    operations = [
        migrations.AlterField(
            model_name='tagsuggestion',
            name='status',
            field=models.CharField(choices=[('pending', 'Pending'), ('accepted', 'Accepted'), ('dismissed', 'Dismissed'), ('auto_applied', 'Auto-applied')], db_index=True, default='pending', max_length=16),
        ),
    ]
