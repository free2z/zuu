# Canonical-with-alias tag normalization (#1209). Hand-written to mirror
# dj/apps/tagging/models.py exactly -- field order included, so
# `makemigrations --check` stays clean.

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tagging', '0001_initial'),
        ('taggit', '0005_auto_20220424_2025'),
    ]

    operations = [
        migrations.CreateModel(
            name='TagAlias',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(max_length=100)),
                ('name_key', models.CharField(db_index=True, max_length=300)),
                ('source', models.CharField(choices=[('deterministic', 'Deterministic'), ('human', 'Human'), ('ai', 'AI')], default='deterministic', max_length=20)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('canonical', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='aliases', to='taggit.tag')),
            ],
            options={
                'ordering': ['name'],
            },
        ),
        migrations.CreateModel(
            name='TagNormalizationRun',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('started_at', models.DateTimeField(auto_now_add=True, db_index=True)),
                ('finished_at', models.DateTimeField(blank=True, null=True)),
                ('dry_run', models.BooleanField(default=False)),
                ('consolidated', models.BooleanField(default=False)),
                ('plan', models.JSONField(default=dict)),
                ('notes', models.CharField(blank=True, default='', max_length=500)),
            ],
            options={
                'ordering': ['-started_at'],
            },
        ),
        migrations.AddConstraint(
            model_name='tagalias',
            constraint=models.UniqueConstraint(fields=('name_key', 'canonical'), name='uniq_tag_alias_per_canonical'),
        ),
    ]
