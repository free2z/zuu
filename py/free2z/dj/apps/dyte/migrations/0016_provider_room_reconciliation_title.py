from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('dyte', '0015_host_start_recovery')]  # noqa: RUF012

    operations = [  # noqa: RUF012
        migrations.AddField(
            model_name='providerroomcleanup',
            name='provider_title',
            field=models.CharField(blank=True, default='', max_length=255),
        ),
    ]
