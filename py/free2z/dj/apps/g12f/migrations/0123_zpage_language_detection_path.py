from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("g12f", "0122_canonicalize_yue_languages")]

    operations = [
        migrations.AddField(
            model_name="zpage",
            name="language_detection_path",
            field=models.CharField(
                blank=True,
                choices=[("live", "Live"), ("batch", "Batch")],
                editable=False,
                max_length=8,
                null=True,
                help_text=(
                    "Detection entry point for the current detected label; "
                    "NULL means unknown or not detected."
                ),
            ),
        ),
    ]
