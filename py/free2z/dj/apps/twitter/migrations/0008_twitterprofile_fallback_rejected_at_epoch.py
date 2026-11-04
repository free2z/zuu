from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('twitter', '0007_announcement'),
    ]

    operations = [
        migrations.AddField(
            model_name='twitterprofile',
            name='fallback_rejected_at_epoch',
            field=models.PositiveIntegerField(
                blank=True,
                editable=False,
                help_text=(
                    'Account epoch at which this profile was rejected as a '
                    'passwordless fallback. Explicit re-linking clears it.'
                ),
                null=True,
            ),
        ),
    ]
