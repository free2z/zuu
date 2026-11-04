"""Adversarial memo classification; none of these tests claim backend issuance."""
import json
from dataclasses import replace

import pytest

from .paymentd_memo import parse_memo, route_event
from .paymentd_protocol import PaymentEvidenceError
from .test_paymentd_protocol import event


def padded(text):
    raw = text.encode('utf-8')
    assert len(raw) <= 512
    return raw + bytes(512-len(raw))


def test_legacy_and_authenticated_memos_preserve_exact_original_text():
    legacy = ' {"act":"buy_2z","id":"corpora"} '
    authenticated = '{"act":"buy_2z","id":"corpora","intent":"12345678-1234-4234-8234-123456789abc","proof":"'+'a'*64+'"}'
    for original in [legacy, authenticated]:
        result = parse_memo(padded(original))
        assert result.buy and result.username == 'corpora'
        assert result.memo_plain == original
    assert authenticated not in repr(result)
    assert 'a'*64 not in repr(result)


@pytest.mark.parametrize('text', [
    'prefix {"act":"buy_2z","id":"corpora"}',
    '{"act":"buy_2z","id":"corpora"} suffix',
    '{"act":"buy_2z","id":"wrong","id":"corpora"}',
    '{"act":"buy_2z","i\\u0064":"wrong","id":"corpora"}',
    '{"act":"buy_2z","id":"corpora"}\0{"act":"buy_2z","id":"other"}',
    '{"act":"buy_2z","id":"cor\0pora"}',
    'null', '[]', 'true',
])
def test_surrounding_text_duplicate_keys_and_embedded_zero_never_route_to_purchase(text):
    assert not parse_memo(padded(text)).buy


@pytest.mark.parametrize('changes', [
    {'id': True}, {'id': ''}, {'id': 'x'*151}, {'id': 'corpora\0'}, {'id':'\ud800'},
    {'id': 'corpora\n'}, {'extra': 'ignored'},
])
def test_purchase_shape_is_strict_but_does_not_invent_authorization(changes):
    payload = dict(act='buy_2z', id='corpora')
    payload.update(changes)
    result = parse_memo(padded(json.dumps(payload)))
    assert not result.buy
    assert result.reason == 'invalid_purchase_instruction'


@pytest.mark.parametrize('raw,reason', [
    (bytes(512),'missing_memo'), (b'\xf6'+bytes(511),'missing_memo'),
    (b'\xf6'+b'purchase'+bytes(503),'non_text_memo'),
    (b'\xff'+bytes(511),'non_text_memo'), (b'\xf5'+bytes(511),'non_text_memo'),
    (b'{\xff'+bytes(510),'invalid_utf8_memo'),
])
def test_empty_opaque_and_invalid_text_are_distinct_capture_reasons(raw,reason):
    result = parse_memo(raw)
    assert not result.buy and result.reason == reason


@pytest.mark.parametrize('raw', [b'', bytes(511), bytes(513), 'not bytes'])
def test_unfetched_or_wrong_length_memo_is_not_verified_empty(raw):
    with pytest.raises(PaymentEvidenceError):
        parse_memo(raw)


@pytest.mark.parametrize('kind', ['payment.observed','payment.confirmed'])
def test_zero_value_buy_selects_durable_nonfinancial_capture(kind):
    e = event()
    e['kind'] = kind
    e['payment']['value_zatoshis'] = 0
    route = route_event(e)
    assert route.phase == 'capture_only' and route.reason == 'zero_value_note'
    assert route.instruction.buy


def test_observation_never_settles_and_revocation_does_not_depend_on_memo_parser():
    e = event()
    e['kind'] = 'payment.observed'
    observation = route_event(e)
    assert observation.phase == 'capture_only'
    e['kind'] = 'payment.confirmed'
    assert route_event(e) == replace(observation,phase='settle_purchase')
    e['kind'] = 'payment.revoked'
    e['payment']['memo_hex'] = padded('broken memo').hex()
    assert route_event(e).phase == 'reconcile_revocation'


def test_malformed_confirmed_payment_remains_capture_only():
    e = event()
    e['payment']['memo_hex'] = padded('prefix '+json.dumps({'act':'buy_2z','id':'corpora'})).hex()
    route = route_event(e)
    assert route.phase == 'capture_only' and route.reason == 'malformed_memo'


def test_embedded_nul_keeps_exact_memo_but_never_selects_unsafe_postgres_text():
    original='{"act":"buy_2z",\0"id":"corpora"}'
    raw=padded(original)
    instruction=parse_memo(raw)
    assert not instruction.buy
    assert instruction.memo_plain == original
    assert instruction.storage_plaintext is None
    assert raw.hex() != padded(original.replace('\0','')).hex()
    escaped='{"act":"buy_2z","id":"corpora\\u0000"}'
    instruction=parse_memo(padded(escaped))
    assert not instruction.buy
    assert instruction.storage_plaintext == escaped


@pytest.mark.parametrize('extra',[{'ref':'historical'}, {'intent':'old-reference'},
    {'proof':True}, {'intent':'not-a-uuid','proof':'not-authority'}])
def test_historical_reference_fields_do_not_authorize_or_block_recipient_routing(extra):
    original=json.dumps(dict(act='buy_2z',id='corpora',**extra))
    result=parse_memo(padded(original))
    assert result.buy and result.username=='corpora' and result.memo_plain==original


@pytest.mark.parametrize('constant',['NaN','Infinity','-Infinity'])
def test_nonstandard_json_never_selects_financial_settlement(constant):
    instruction=parse_memo(padded('{"act":"buy_2z","id":"corpora","promo":'+constant+'}'))
    assert not instruction.buy and instruction.reason=='malformed_memo'
