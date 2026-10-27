import django.db.models.deletion
import django.db.models.functions.datetime
import uuid
from django.conf import settings
from django.db import migrations, models
from ._foundation_sql import SQL, REVERSE


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ('ledger', '0006_call_features'),
        ('tuzis', '0009_subscription_intent_abandonment'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.RunSQL("SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '60s';", migrations.RunSQL.noop),
        migrations.CreateModel(
            name='LegalPayee',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, primary_key=True, serialize=False)),
                ('legal_name', models.TextField()),
                ('jurisdiction', models.CharField(max_length=64)),
                ('verification', models.JSONField()),
                ('verified_at', models.DateTimeField()),
                ('verified_by', models.CharField(max_length=128)),
            ],
        ),
        migrations.CreateModel(
            name='CompensationSchedule',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('service', models.CharField(max_length=64)),
                ('version', models.CharField(max_length=64)),
                ('contract_version', models.CharField(max_length=64)),
                ('nusd_per_allocated_m2z', models.BigIntegerField()),
                ('effective_at', models.DateTimeField()),
                ('ends_at', models.DateTimeField(null=True)),
                ('published_digest', models.CharField(max_length=64)),
            ],
            options={
                'constraints': [models.UniqueConstraint(fields=('service', 'version'), name='economy_schedule_version'), models.CheckConstraint(condition=models.Q(('nusd_per_allocated_m2z__gt', 0)), name='economy_schedule_rate'), models.CheckConstraint(condition=models.Q(('ends_at__isnull', True), ('ends_at__gt', models.F('effective_at')), _connector='OR'), name='economy_schedule_period')],
            },
        ),
        migrations.CreateModel(
            name='EconomicPolicy',
            fields=[
                ('id', models.BooleanField(default=True, primary_key=True, serialize=False)),
                ('version', models.PositiveIntegerField(db_default=0)),
                ('fenced', models.BooleanField(db_default=False)),
                ('activated_at', models.DateTimeField(null=True)),
                ('account_daily_limit_m2z', models.BigIntegerField(db_default=200000000)),
                ('purchaser_daily_limit_nusd', models.BigIntegerField(db_default=10000000000000)),
                ('manifest', models.JSONField(db_default={})),
            ],
            options={
                'constraints': [models.CheckConstraint(condition=models.Q(('id', True)), name='economy_policy_singleton'), models.CheckConstraint(condition=models.Q(('version__in', [0, 1])), name='economy_policy_version'), models.CheckConstraint(condition=models.Q(('account_daily_limit_m2z__gt', 0), ('account_daily_limit_m2z__lte', 200000000)), name='economy_funding_limit'), models.CheckConstraint(condition=models.Q(('purchaser_daily_limit_nusd__gt', 0), ('purchaser_daily_limit_nusd__lte', 10000000000000)), name='economy_sales_limit')],
            },
        ),
        migrations.CreateModel(
            name='LegacyClaim',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('snapshot_key', models.CharField(max_length=128)),
                ('snapshot_at', models.DateTimeField()),
                ('usage_snapshot_m2z', models.BigIntegerField()),
                ('classification', models.CharField(db_default='unclassified', max_length=32)),
                ('liability_nusd', models.BigIntegerField(null=True)),
                ('evidence', models.JSONField()),
                ('creator', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, to=settings.AUTH_USER_MODEL)),
            ],
        ),
        migrations.CreateModel(
            name='LegacyClaimDecision',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('classification', models.CharField(max_length=32)),
                ('liability_nusd', models.BigIntegerField(null=True)),
                ('basis', models.JSONField()),
                ('operator', models.CharField(max_length=128)),
                ('created_at', models.DateTimeField(db_default=django.db.models.functions.datetime.Now())),
                ('claim', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='decisions', to='economy.legacyclaim')),
            ],
        ),
        migrations.CreateModel(
            name='CreatorPayable',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('currency', models.CharField(db_default='USD', max_length=3)),
                ('balance_nusd', models.BigIntegerField(db_default=0)),
                ('held_nusd', models.BigIntegerField(db_default=0)),
                ('created_at', models.DateTimeField(db_default=django.db.models.functions.datetime.Now())),
                ('creator', models.OneToOneField(on_delete=django.db.models.deletion.PROTECT, to=settings.AUTH_USER_MODEL)),
                ('legal_payee', models.ForeignKey(null=True, on_delete=django.db.models.deletion.PROTECT, to='economy.legalpayee')),
            ],
        ),
        migrations.CreateModel(
            name='CompensationAgreement',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('contract_version', models.CharField(max_length=64)),
                ('contract_digest', models.CharField(max_length=64)),
                ('accepted_at', models.DateTimeField()),
                ('effective_at', models.DateTimeField()),
                ('revoked_at', models.DateTimeField(null=True)),
                ('acceptance_evidence', models.JSONField()),
                ('accepted_by', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='+', to=settings.AUTH_USER_MODEL)),
                ('creator', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='+', to=settings.AUTH_USER_MODEL)),
                ('legal_payee', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, to='economy.legalpayee')),
            ],
        ),
        migrations.CreateModel(
            name='PaymentRequest',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, primary_key=True, serialize=False)),
                ('idempotency_key', models.CharField(max_length=200)),
                ('amount_nusd', models.BigIntegerField()),
                ('address', models.TextField()),
                ('address_authorization', models.JSONField()),
                ('state', models.CharField(db_default='requested', max_length=24)),
                ('review', models.JSONField(db_default={})),
                ('settlement', models.JSONField(db_default={})),
                ('txid', models.CharField(max_length=64, null=True, unique=True)),
                ('created_at', models.DateTimeField(db_default=django.db.models.functions.datetime.Now())),
                ('updated_at', models.DateTimeField(db_default=django.db.models.functions.datetime.Now())),
                ('account', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, to='economy.creatorpayable')),
                ('legal_payee', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, to='economy.legalpayee')),
                ('requested_by', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, to=settings.AUTH_USER_MODEL)),
            ],
        ),
        migrations.CreateModel(
            name='PurchaserDay',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('day', models.DateField()),
                ('sold_nusd', models.BigIntegerField(db_default=0)),
                ('reserved_nusd', models.BigIntegerField(db_default=0)),
                ('purchaser', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, to=settings.AUTH_USER_MODEL)),
            ],
        ),
        migrations.CreateModel(
            name='ServiceAdmission',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, primary_key=True, serialize=False)),
                ('service', models.CharField(max_length=64)),
                ('event_id', models.CharField(max_length=200)),
                ('policy_version', models.PositiveIntegerField()),
                ('admitted_at', models.DateTimeField()),
                ('source', models.JSONField()),
                ('source_digest', models.CharField(max_length=64)),
                ('account', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, to='economy.creatorpayable')),
                ('agreement', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, to='economy.compensationagreement')),
                ('creator', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, to=settings.AUTH_USER_MODEL)),
                ('legal_payee', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, to='economy.legalpayee')),
                ('schedule', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, to='economy.compensationschedule')),
            ],
        ),
        migrations.CreateModel(
            name='PayableJournal',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('idempotency_key', models.CharField(max_length=240, unique=True)),
                ('delta_nusd', models.BigIntegerField()),
                ('kind', models.CharField(max_length=24)),
                ('allocated_m2z', models.BigIntegerField(null=True)),
                ('basis', models.JSONField()),
                ('created_at', models.DateTimeField(db_default=django.db.models.functions.datetime.Now())),
                ('account', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, to='economy.creatorpayable')),
                ('payment', models.OneToOneField(null=True, on_delete=django.db.models.deletion.PROTECT, to='economy.paymentrequest')),
                ('admission', models.OneToOneField(null=True, on_delete=django.db.models.deletion.PROTECT, to='economy.serviceadmission')),
            ],
        ),
        migrations.CreateModel(
            name='FundingDay',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('day', models.DateField()),
                ('opening_m2z', models.BigIntegerField()),
                ('incoming_m2z', models.BigIntegerField(db_default=0)),
                ('reserved_m2z', models.BigIntegerField(db_default=0)),
                ('account', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, to='ledger.account')),
            ],
            options={
                'constraints': [models.UniqueConstraint(fields=('account', 'day'), name='economy_funding_day_identity'), models.CheckConstraint(condition=models.Q(('incoming_m2z__gte', 0), ('opening_m2z__gte', 0), ('reserved_m2z__gte', 0)), name='economy_funding_day_nonnegative')],
            },
        ),
        migrations.CreateModel(
            name='FundingReservation',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('idempotency_key', models.CharField(max_length=200, unique=True)),
                ('day', models.DateField()),
                ('amount_m2z', models.BigIntegerField()),
                ('sale_nusd', models.BigIntegerField()),
                ('state', models.CharField(db_default='reserved', max_length=24)),
                ('external_receipt', models.JSONField(db_default={})),
                ('created_at', models.DateTimeField(db_default=django.db.models.functions.datetime.Now())),
                ('account', models.ForeignKey(null=True, on_delete=django.db.models.deletion.PROTECT, to='ledger.account')),
                ('purchaser', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, to=settings.AUTH_USER_MODEL)),
                ('recipient', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='+', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'constraints': [models.CheckConstraint(condition=models.Q(('amount_m2z__gt', 0), ('sale_nusd__gte', 0)), name='economy_funding_res_amount'), models.CheckConstraint(condition=models.Q(('state__in', ['reserved', 'issuing', 'issued', 'released', 'resolution'])), name='economy_funding_res_state'), models.CheckConstraint(condition=models.Q(('account__isnull', False), ('state', 'resolution'), _connector='OR'), name='economy_funding_res_account')],
            },
        ),
        migrations.AddConstraint(
            model_name='legacyclaim',
            constraint=models.UniqueConstraint(fields=('creator', 'snapshot_key'), name='economy_legacy_identity'),
        ),
        migrations.AddConstraint(
            model_name='legacyclaim',
            constraint=models.CheckConstraint(condition=models.Q(('liability_nusd__isnull', True), ('liability_nusd__gte', 0), _connector='OR'), name='economy_legacy_liability'),
        ),
        migrations.AddConstraint(
            model_name='legacyclaimdecision',
            constraint=models.CheckConstraint(condition=models.Q(('liability_nusd__isnull', True), ('liability_nusd__gte', 0), _connector='OR'), name='economy_legacy_decision_amount'),
        ),
        migrations.AddConstraint(
            model_name='creatorpayable',
            constraint=models.CheckConstraint(condition=models.Q(('currency', 'USD')), name='economy_payable_usd'),
        ),
        migrations.AddConstraint(
            model_name='creatorpayable',
            constraint=models.CheckConstraint(condition=models.Q(('held_nusd__gte', 0)), name='economy_held_nonnegative'),
        ),
        migrations.AddConstraint(
            model_name='creatorpayable',
            constraint=models.CheckConstraint(condition=models.Q(('balance_nusd__gte', 0)), name='economy_owed_nonnegative'),
        ),
        migrations.AddConstraint(
            model_name='compensationagreement',
            constraint=models.CheckConstraint(condition=models.Q(('effective_at__gte', models.F('accepted_at'))), name='economy_agreement_effective'),
        ),
        migrations.AddConstraint(
            model_name='paymentrequest',
            constraint=models.UniqueConstraint(fields=('account', 'idempotency_key'), name='economy_payment_identity'),
        ),
        migrations.AddConstraint(
            model_name='paymentrequest',
            constraint=models.CheckConstraint(condition=models.Q(('amount_nusd__gt', 0)), name='economy_payment_amount'),
        ),
        migrations.AddConstraint(
            model_name='paymentrequest',
            constraint=models.CheckConstraint(condition=models.Q(('state__in', ['requested', 'approved', 'signing', 'broadcast_unknown', 'broadcast', 'confirmed', 'rejected'])), name='economy_payment_state'),
        ),
        migrations.AddConstraint(
            model_name='purchaserday',
            constraint=models.UniqueConstraint(fields=('purchaser', 'day'), name='economy_purchaser_day_identity'),
        ),
        migrations.AddConstraint(
            model_name='purchaserday',
            constraint=models.CheckConstraint(condition=models.Q(('reserved_nusd__gte', 0), ('sold_nusd__gte', 0)), name='economy_purchaser_nonnegative'),
        ),
        migrations.AddConstraint(
            model_name='serviceadmission',
            constraint=models.UniqueConstraint(fields=('service', 'event_id'), name='economy_service_identity'),
        ),
        migrations.AddConstraint(
            model_name='payablejournal',
            constraint=models.CheckConstraint(condition=models.Q(models.Q(('delta_nusd', 0), _negated=True), models.Q(('allocated_m2z', 0), ('kind', 'service')), _connector='OR'), name='economy_journal_nonzero'),
        ),
        migrations.AddConstraint(
            model_name='payablejournal',
            constraint=models.CheckConstraint(condition=models.Q(('kind__in', ['service', 'adjustment', 'payment', 'usage_purchase'])), name='economy_journal_kind'),
        ),
        migrations.AddConstraint(
            model_name='payablejournal',
            constraint=models.CheckConstraint(condition=models.Q(models.Q(('admission__isnull', False), ('allocated_m2z__gte', 0), ('allocated_m2z__isnull', False), ('delta_nusd__gte', 0), ('kind', 'service')), models.Q(models.Q(('kind', 'service'), _negated=True), ('admission__isnull', True)), _connector='OR'), name='economy_service_journal'),
        ),
        migrations.AddConstraint(
            model_name='payablejournal',
            constraint=models.CheckConstraint(condition=models.Q(models.Q(('delta_nusd__lt', 0), ('kind', 'payment'), ('payment__isnull', False)), models.Q(models.Q(('kind', 'payment'), _negated=True), ('payment__isnull', True)), _connector='OR'), name='economy_payment_journal'),
        ),
        migrations.RunSQL(SQL, REVERSE),
    ]
