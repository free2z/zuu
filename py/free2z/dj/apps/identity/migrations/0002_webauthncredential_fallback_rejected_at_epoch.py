from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("identity", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="webauthncredential",
            name="fallback_rejected_at_epoch",
            field=models.PositiveIntegerField(
                blank=True,
                editable=False,
                help_text=(
                    "Account epoch at which this passkey was rejected as a "
                    "passwordless fallback. Explicit re-registration clears it."
                ),
                null=True,
            ),
        ),
    ]
