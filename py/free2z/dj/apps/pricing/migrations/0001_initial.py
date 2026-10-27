from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name='ZecPriceSnapshot',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('created_at', models.DateTimeField(auto_now_add=True, db_index=True)),
                ('zec_usd', models.DecimalField(decimal_places=6, max_digits=16)),
                ('median_usd', models.DecimalField(decimal_places=6, max_digits=16)),
                ('spread', models.DecimalField(decimal_places=4, max_digits=5)),
                ('tuzis_per_zec', models.DecimalField(decimal_places=4, max_digits=18)),
                ('num_sources', models.PositiveIntegerField(default=0)),
                ('sources', models.JSONField(default=dict)),
                ('rejected', models.JSONField(blank=True, default=dict)),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
    ]
