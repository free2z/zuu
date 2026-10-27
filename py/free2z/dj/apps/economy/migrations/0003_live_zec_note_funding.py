import uuid
from decimal import Decimal
from django.db import migrations, models
from ._live_zec_sql import SQL, REVERSE


def seed_disabled_offers(apps, schema_editor):
    offer = apps.get_model('economy', 'ZecPromotion')
    for code, title in [('', 'Zcash launch bonus'), ('ZODL', 'ZODL bonus')]:
        offer.objects.using(schema_editor.connection.alias).get_or_create(code=code,
            defaults={'title':title, 'multiplier':Decimal('2'), 'enabled':False})


class Migration(migrations.Migration):
    dependencies = [('economy', '0002_service_delivery_and_captured_notes')]
    operations = [
        migrations.CreateModel(
            name='ZecPromotion',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('code', models.CharField(blank=True, default='', max_length=64, unique=True)),
                ('title', models.CharField(max_length=160)),
                ('multiplier', models.DecimalField(decimal_places=4, default=1, max_digits=8)),
                ('enabled', models.BooleanField(default=False)),
                ('starts_at', models.DateTimeField(blank=True, null=True)),
                ('ends_at', models.DateTimeField(blank=True, null=True)),
            ],
            options={
                'constraints': [models.CheckConstraint(condition=models.Q(('multiplier__gte', 1), ('multiplier__lte', 9999)), name='economy_zec_promo_multiplier'), models.CheckConstraint(condition=models.Q(('code', ''), ('code__regex', '^[A-Z0-9_-]{1,64}$'), _connector='OR'), name='economy_zec_promo_code'), models.CheckConstraint(condition=models.Q(('ends_at__isnull', True), ('starts_at__isnull', True), ('ends_at__gt', models.F('starts_at')), _connector='OR'), name='economy_zec_promo_period'), models.CheckConstraint(condition=models.Q(('enabled', False), ('ends_at__isnull', False), _connector='OR'), name='economy_zec_promo_enabled_end')],
            },
        ),
        migrations.RunPython(seed_disabled_offers, migrations.RunPython.noop),
        migrations.RunSQL("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='60s';", migrations.RunSQL.noop),
        migrations.RunSQL(SQL, REVERSE),
    ]
