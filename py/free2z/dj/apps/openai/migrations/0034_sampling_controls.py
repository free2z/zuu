from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("openai", "0033_aimodel_forced_tool_choice")]
    operations = [
        migrations.AddField(model_name="aimodel", name="supports_top_k", field=models.BooleanField(default=False, db_default=False)),
        migrations.AddField(model_name="aimodel", name="supports_seed", field=models.BooleanField(default=False, db_default=False)),
        migrations.AddField(model_name="aimodel", name="supports_logprobs", field=models.BooleanField(default=False, db_default=False)),
        migrations.AddField(model_name="aimodel", name="supports_penalties", field=models.BooleanField(default=False, db_default=False)),
        migrations.AddField(model_name="aimodel", name="temperature_top_p_exclusive", field=models.BooleanField(default=False, db_default=False)),
        migrations.AddField(model_name="aimodel", name="sampling_temperature", field=models.BooleanField(null=True, blank=True, default=None)),
        migrations.AddField(model_name="aimodel", name="sampling_top_p", field=models.BooleanField(null=True, blank=True, default=None)),
    ]
