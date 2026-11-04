from types import SimpleNamespace
from datetime import timedelta
import uuid
import pytest

from django.utils import timezone

from dj.apps.economy import contracts
from dj.apps.purchases.serializers import intent_payload


@pytest.mark.django_db
def test_zcash_instructions_publish_exact_method_without_internal_provider_data():
    now = timezone.now()
    intent = SimpleNamespace(pk=uuid.uuid4(), wire_rail='zcash', status='pending', quantity_2z=100,
        currency='USD', price_minor=112, pricing_version=contracts.ZEC_FUNDING_VERSION,
        created_at=now, expires_at=now+timedelta(minutes=30), credited_at=None, credited_milli_2z=None,
        rail_data={'address': 'public-address', 'amount_zec': '0.00222223', 'memo': 'original-intent-matching-token',
            'gross_usd': '1.111115000', 'associated_value_usd': '1.000000000', 'payment_observed': False,
            'funding_reservation_id': 'internal', 'secret_provider_json': {'secret': 'never public'}},
        quote={'pricing_version': contracts.ZEC_FUNDING_VERSION, 'quoted_at': now.isoformat(),
            'sources': {'kraken': '500', 'coinbase': '500', 'https://private.example/token': 'secret'},
            'zec_usd': '500.000000', 'spread': '0.1000', 'tuzis_per_zec': '45000.0000', 'bonus_m2z': '0'})
    result = intent_payload(intent)
    actual = result['zcash_funding']
    assert actual['funding_method_text'] == contracts.ZEC_FUNDING_TEXT
    assert actual['funding_method_digest'] == contracts.text_digest(actual['funding_method_text'])
    assert actual['source_names'] == ['coinbase', 'kraken']
    assert actual['spread'] == '0.1000' and actual['bonus_m2z'] == '0'
    assert actual['amount_zec'] == '0.00222223'
    assert result['credited_at'] is None and result['credited_milli_2z'] is None
    assert 'funding_reservation_id' not in result['rail_data']
    assert 'secret' not in str(result) and 'private.example' not in str(result)


@pytest.mark.django_db
def test_unproved_historical_card_amount_is_not_issuance(monkeypatch, creator_factory):
    from dj.apps.ztripe import serializers
    monkeypatch.setattr(serializers, 'find_spec', lambda name: None)
    from dj.apps.ztripe.serializers import TransactionSerializer
    transaction = SimpleNamespace(pk=123, user_id=creator_factory().pk, tuzis_credited=100)
    serializer = TransactionSerializer()
    assert serializer.issuance(transaction) == {'status': 'unavailable', 'credited': False, 'credited_m2z': None}


@pytest.mark.django_db
def test_existing_stripe_cursor_proves_actual_delivery_without_future_writer(monkeypatch, creator_factory):
    from dj.apps.tuzis import ledger
    from dj.apps.ztripe import serializers
    from dj.apps.ztripe.models import StripeTransaction
    creator = creator_factory()
    row = StripeTransaction.objects.create(user=creator, amount=100, tuzis_credited=100, stripe_charge_id='pi:proof')
    ledger.credit(creator, 100, source='sys:clearing_stripe', ref_kind='stripe_transaction', ref_id=str(row.pk), idem='stripe:proof')
    monkeypatch.setattr(serializers, 'find_spec', lambda name: None)
    payload = serializers.TransactionSerializer(row).data
    assert payload['status'] == 'credited' and payload['credited'] is True
    assert payload['credited_m2z'] == '100000'


@pytest.mark.django_db
def test_nominal_backfill_cursor_without_journal_is_not_delivery(monkeypatch, creator_factory):
    from dj.apps.ledger import api
    from dj.apps.ledger.models import Account, PurchaseRefund
    from dj.apps.ztripe import serializers
    from dj.apps.ztripe.models import StripeTransaction
    creator = creator_factory()
    api.ensure_account(creator.pk)
    row = StripeTransaction.objects.create(user=creator, amount=100, tuzis_credited=100, stripe_charge_id='pi:backfill')
    PurchaseRefund.objects.create(account=Account.objects.get(key=f'user:{creator.pk}'), rail='stripe', ref_kind='stripe_transaction', ref_id=str(row.pk), credited_m2z=100000)
    monkeypatch.setattr(serializers, 'find_spec', lambda name: None)
    payload = serializers.TransactionSerializer(row).data
    assert payload['status'] == 'unavailable' and payload['credited'] is False
    assert payload['credited_m2z'] is None


@pytest.mark.django_db
@pytest.mark.parametrize('debt', [40000, 100000])
def test_original_stripe_delivery_includes_purchase_debt_repayment(monkeypatch, creator_factory, debt):
    from dj.apps.ledger import api
    from dj.apps.ztripe import serializers
    from dj.apps.ztripe.models import StripeTransaction
    creator = creator_factory(tuzis=0)
    api.clawback(creator.pk, debt, 'sys:clearing_stripe', 'clawback', 'dispute', 'stripe_transaction', 'old', f'debt:{debt}')
    row = StripeTransaction.objects.create(user=creator, amount=100, tuzis_credited=100, stripe_charge_id=f'pi:debt:{debt}')
    api.credit_purchase(creator.pk, 100000, 'stripe', 'stripe_transaction', str(row.pk), f'purchase:{debt}')
    monkeypatch.setattr(serializers, 'find_spec', lambda name: None)
    payload = serializers.TransactionSerializer(row).data
    assert payload['status'] == 'credited' and payload['credited'] is True
    assert payload['credited_m2z'] == '100000'


def test_funding_actor_dtos_preserve_legacy_calls_and_exact_new_actor_assertions():
    from dj.apps.purchases.serializers import PurchaseIntentCreateSerializer
    from dj.apps.ztripe.serializers import CheckoutSessionRequestSerializer
    for serializer, base in (
        (CheckoutSessionRequestSerializer, {'quantity': 1}),
        (PurchaseIntentCreateSerializer, {'rail': 'zcash', 'quantity_2z': 1, 'platform': 'web'}),
    ):
        assert serializer(data=base).is_valid()
        valid = serializer(data={**base, 'expected_actor_id': 123})
        assert valid.is_valid() and valid.validated_data['expected_actor_id'] == 123
        for invalid in ('123', True, 0, -1):
            assert not serializer(data={**base, 'expected_actor_id': invalid}).is_valid()
