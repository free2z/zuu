from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("tuzis", "0004_zecpendingnotice_and_more"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="ProviderReservation",
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
                ("scope", models.CharField(max_length=64)),
                ("operation_key", models.UUIDField()),
                (
                    "amount",
                    models.DecimalField(decimal_places=3, max_digits=17),
                ),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("active", "Active"),
                            ("settled", "Settled"),
                            ("released", "Released"),
                        ],
                        default="active",
                        max_length=8,
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("finished_at", models.DateTimeField(blank=True, null=True)),
                (
                    "user",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="provider_reservations",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "indexes": [
                    models.Index(
                        fields=["user", "status", "created_at"],
                        name="tuzis_prov_user_status_idx",
                    )
                ],
                "constraints": [
                    models.UniqueConstraint(
                        condition=models.Q(status="active"),
                        fields=("scope", "user", "operation_key"),
                        name="active_provider_reservation_uniq",
                    )
                ],
            },
        ),
    ]
