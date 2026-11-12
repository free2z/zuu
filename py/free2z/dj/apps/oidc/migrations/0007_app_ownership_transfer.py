import uuid

from django.db import migrations, models
from django.db.models import Q
from django.utils import timezone


class Migration(migrations.Migration):
    dependencies = [
        ("oidc", "0006_mcpairequest"),
        ("ledger", "0003_holds"),
        ("purchases", "0001_initial"),
    ]

    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '30s';",
            reverse_sql="SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '30s';",
        ),
        migrations.CreateModel(
            name="AppOwnershipTransfer",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("application_id", models.UUIDField(db_index=True)),
                ("application_name", models.CharField(max_length=255)),
                ("sender_id", models.BigIntegerField(db_index=True)),
                ("recipient_id", models.BigIntegerField(db_index=True)),
                ("sender_epoch", models.PositiveIntegerField()),
                ("recipient_epoch", models.PositiveIntegerField()),
                ("created_at", models.DateTimeField(default=timezone.now)),
                ("expires_at", models.DateTimeField()),
                ("resolved_at", models.DateTimeField(blank=True, null=True)),
                ("state", models.CharField(default="pending", max_length=16)),
            ],
            options={"constraints": [models.UniqueConstraint(
                condition=Q(state="pending"), fields=("application_id",),
                name="oidc_one_pending_app_transfer") ]},
        ),
        migrations.RunSQL(
            sql="""
            CREATE FUNCTION public.oidc_active_app_admission() RETURNS trigger
            LANGUAGE plpgsql AS $$
            DECLARE owner_active boolean; owner_id bigint;
            BEGIN
                SELECT user_id INTO owner_id FROM public.oidc_f2zapplication
                WHERE id = NEW.application_id FOR KEY SHARE;
                IF NOT FOUND THEN
                    RAISE EXCEPTION 'application unavailable' USING ERRCODE = '23514';
                END IF;
                IF owner_id IS NOT NULL THEN
                    SELECT is_active INTO owner_active FROM public.g12f_creator WHERE id = owner_id;
                    IF NOT coalesce(owner_active, false) THEN
                        RAISE EXCEPTION 'application owner unavailable' USING ERRCODE = '23514';
                    END IF;
                END IF;
                RETURN NEW;
            END $$;
            CREATE TRIGGER oidc_active_grant_admission BEFORE INSERT ON public.oidc_appauthorization
            FOR EACH ROW EXECUTE FUNCTION public.oidc_active_app_admission();
            CREATE TRIGGER oidc_active_grant_update BEFORE UPDATE ON public.oidc_appauthorization
            FOR EACH ROW WHEN (NEW.revoked_at IS NULL)
            EXECUTE FUNCTION public.oidc_active_app_admission();
            CREATE TRIGGER oidc_active_purchase_admission BEFORE INSERT ON public.purchases_purchaseintent
            FOR EACH ROW WHEN (NEW.application_id IS NOT NULL)
            EXECUTE FUNCTION public.oidc_active_app_admission();
            CREATE FUNCTION public.oidc_transfer_hold_admission() RETURNS trigger
            LANGUAGE plpgsql AS $$ BEGIN
                PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.app_id::text, 1303));
                RETURN NEW;
            END $$;
            CREATE TRIGGER oidc_transfer_hold_admission BEFORE INSERT ON public.ledger_hold
            FOR EACH ROW EXECUTE FUNCTION public.oidc_transfer_hold_admission();
            """,
            reverse_sql="""
            SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '30s';
            DROP TRIGGER oidc_transfer_hold_admission ON public.ledger_hold;
            DROP FUNCTION public.oidc_transfer_hold_admission();
            DROP TRIGGER oidc_active_grant_admission ON public.oidc_appauthorization;
            DROP TRIGGER oidc_active_grant_update ON public.oidc_appauthorization;
            DROP TRIGGER oidc_active_purchase_admission ON public.purchases_purchaseintent;
            DROP FUNCTION public.oidc_active_app_admission();
            """,
        ),
    ]
