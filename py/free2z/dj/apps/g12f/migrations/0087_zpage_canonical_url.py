from django.db import migrations, models

import dj.apps.g12f.validators


class Migration(migrations.Migration):

    dependencies = [
        ("g12f", "0086_alter_creator_p2paddr_alter_zpage_p2paddr"),
    ]

    operations = [
        # AddField needs ACCESS EXCLUSIVE even though this nullable column is a
        # metadata-only change. Bound the wait so a long-running request cannot
        # make the pending ALTER queue every later zPage query in production.
        migrations.RunSQL(
            "SET LOCAL lock_timeout = '3s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.AddField(
            model_name="zpage",
            name="canonical_url",
            field=models.URLField(
                blank=True,
                help_text=(
                    "Optional original article URL used as the canonical URL "
                    "when this page republishes content from another site"
                ),
                max_length=2048,
                validators=[dj.apps.g12f.validators.validate_canonical_url],
            ),
        ),
    ]
