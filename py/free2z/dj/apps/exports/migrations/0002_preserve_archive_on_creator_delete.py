import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("exports", "0001_initial"),
    ]

    operations = [
        migrations.AlterField(
            model_name="publicationexportjob",
            name="creator",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="publication_export_jobs",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
    ]
