from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("g12f", "0083_alter_zpage_options_and_more"),
    ]

    operations = [
        migrations.AddIndex(
            model_name="zpage",
            index=models.Index(
                condition=models.Q(("is_published", True)),
                fields=["creator_id"],
                name="g12f_zpage_pub_creator_idx",
            ),
        ),
    ]
