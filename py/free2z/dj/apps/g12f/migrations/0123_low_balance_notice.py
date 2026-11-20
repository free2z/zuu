from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('g12f', '0122_canonicalize_yue_languages')]

    operations = [
        migrations.RunSQL("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s';", migrations.RunSQL.noop),
        migrations.AddField('creator', 'low_balance_notice_enabled', models.BooleanField(default=False, db_default=False, editable=False)),
        migrations.AddField('creator', 'low_balance_notice_generation', models.PositiveBigIntegerField(default=0, db_default=0, editable=False)),
        migrations.AddField('creator', 'low_balance_notice_pending', models.BooleanField(default=False, db_default=False, editable=False)),
        migrations.AddField('creator', 'low_balance_notice_pending_epoch', models.PositiveIntegerField(null=True, blank=True, editable=False)),
        migrations.AddField('creator', 'low_balance_notice_attempted_at', models.DateTimeField(null=True, blank=True, editable=False)),
        migrations.AddField('creator', 'low_balance_notice_locale', models.CharField(max_length=8, default='en', db_default='en', editable=False)),
        migrations.RunSQL(migrations.RunSQL.noop, """
            SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s';
            LOCK TABLE g12f_creator IN ACCESS EXCLUSIVE MODE;
            DO $$ BEGIN
              IF EXISTS (SELECT 1 FROM g12f_creator WHERE low_balance_notice_enabled
                OR low_balance_notice_generation <> 0 OR low_balance_notice_pending OR low_balance_notice_pending_epoch IS NOT NULL
                OR low_balance_notice_attempted_at IS NOT NULL OR low_balance_notice_locale <> 'en') THEN
                RAISE EXCEPTION 'low balance preference state exists; roll forward';
              END IF;
            END $$;
        """),
    ]
