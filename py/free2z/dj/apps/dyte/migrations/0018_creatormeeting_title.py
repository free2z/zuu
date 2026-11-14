from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('dyte', '0017_merge_host_start_zero_probe')]

    operations = [
        migrations.AddField(
            model_name='creatormeeting',
            name='title',
            field=models.CharField(blank=True, db_default='', default='', max_length=255),
        ),
    ]
