from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('kyc', '0006_alter_userprofile_additional_document_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='userprofile',
            name='rejection_reason',
            field=models.TextField(blank=True, default=''),
        ),
    ]
