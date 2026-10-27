from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('social', '0002_socialidentity_linked_at_epoch'),
    ]

    operations = [
        migrations.AddField(
            model_name='socialidentity',
            name='fallback_rejected_at_epoch',
            field=models.PositiveIntegerField(
                blank=True,
                editable=False,
                help_text=(
                    'Account epoch at which this identity was rejected as a '
                    'passwordless fallback. Explicit re-linking clears it.'
                ),
                null=True,
            ),
        ),
    ]
