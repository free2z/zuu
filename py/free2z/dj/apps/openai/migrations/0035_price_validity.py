from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("openai", "0034_sampling_controls")]
    operations = [
        migrations.AddField(model_name="aimodel", name="price_checked_at", field=models.DateField(null=True, blank=True, db_default=None)),
        migrations.AddField(model_name="aimodel", name="price_valid_until", field=models.DateTimeField(null=True, blank=True, db_default=None, help_text="Exclusive expiry for time-limited provider prices; unavailable after this instant.")),
    ]
