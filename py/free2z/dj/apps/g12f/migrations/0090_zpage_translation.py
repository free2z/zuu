from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    # Table creation, its indexes, and its uniqueness constraint either all
    # commit and receive a migration record or all roll back for a clean retry.
    dependencies = [("g12f", "0089_backfill_zpage_source_language")]

    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout = '3s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.CreateModel(
            name="ZPageTranslation",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                (
                    "language",
                    models.CharField(
                        choices=[
                            ("en", "English"),
                            ("es", "Spanish"),
                            ("fr", "French"),
                            ("pt-BR", "Portuguese (Brazil)"),
                        ],
                        max_length=10,
                    ),
                ),
                ("title", models.CharField(max_length=128)),
                ("content", models.TextField(max_length=100000)),
                ("description", models.CharField(blank=True, max_length=255)),
                (
                    "is_published",
                    models.BooleanField(db_index=True, default=False),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "zpage",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="translations",
                        to="g12f.zpage",
                    ),
                ),
            ],
            options={"ordering": ["language"]},
        ),
        migrations.AddConstraint(
            model_name="zpagetranslation",
            constraint=models.UniqueConstraint(
                fields=("zpage", "language"),
                name="g12f_unique_zpage_translation_language",
            ),
        ),
        migrations.AddIndex(
            model_name="zpagetranslation",
            index=models.Index(
                fields=["zpage", "is_published"],
                name="g12f_zpage_translation_pub_idx",
            ),
        ),
    ]
