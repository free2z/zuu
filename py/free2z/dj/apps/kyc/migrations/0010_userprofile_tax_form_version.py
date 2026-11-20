from django.db import migrations, models

class Migration(migrations.Migration):
    dependencies = [('kyc', '0009_userprofile_tax_form_classification')]
    operations = [migrations.AddField(model_name='userprofile', name='tax_form_version', field=models.PositiveBigIntegerField(default=0))]
