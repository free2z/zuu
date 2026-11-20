from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('kyc', '0008_alter_userprofile_additional_document_and_more')]
    operations = [
        migrations.AddField(
            model_name='userprofile', name='tax_form_classification',
            field=models.CharField(blank=True, default='', max_length=16),
        ),
    ]
