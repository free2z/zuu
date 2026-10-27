"""Financial stdin is untrusted; pinned local observer evidence is mandatory."""
import copy
import json
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from dj.apps.g12f.paymentd_protocol import LocalEvidence, PaymentEvidenceError, decode_event, private_bytes, private_config_path


def event():
    text=b'{"act":"buy_2z","id":"corpora"}'
    payment = dict(id=f"main:{'a'*64}:ironwood:0", txid='a'*64,
        pool='ironwood', output_index=0, value_zatoshis=909007,
        memo_hex=(text + bytes(512-len(text))).hex(), recipient_hex='b'*86)
    return dict(schema_version=1, journal_sequence=3, kind='payment.confirmed',
        network='main', revision=1, block_height=3513370, block_hash='c'*64,
        payment=payment, event_id=f"{payment['id']}:1:confirmed")


def verifier():
    # Bypass only root installation ownership; validation and invocation are real.
    v = object.__new__(LocalEvidence)
    v.binary = '/usr/local/libexec/paymentd'
    v.config_path = '/etc/free2z-paymentd/current.toml'
    v.config = {'confirmations':3, 'max_tip_age_seconds':900}
    v.receivers = {'ufvk_sha256':'d'*64, 'receivers':{'ironwood':['b'*86]}}
    return v


def proof(e):
    return dict(schema_version=1,event=e,confirmations=3,
        ufvk_sha256='d'*64,verified_at=1000,valid_until=1900)


def test_exact_payment_and_binary_memo_survive_parser():
    e = event()
    assert decode_event(json.dumps(e).encode()) == e
    assert len(bytes.fromhex(e['payment']['memo_hex'])) == 512


@pytest.mark.parametrize('modify', [
    lambda e:e.update(network='test'), lambda e:e.update(schema_version=True),
    lambda e:e.update(revision=True), lambda e:e.update(event_id='forged'),
    lambda e:e['payment'].update(value_zatoshis=True),
    lambda e:e['payment'].update(output_index=-1),
    lambda e:e['payment'].update(pool='transparent'),
    lambda e:e['payment'].update(memo_hex=''),
    lambda e:e['payment'].update(txid='A'*64),
    lambda e:e['payment'].update(recipient_hex='ab'),
])
def test_invalid_financial_coordinates_are_rejected(modify):
    e=event()
    modify(e)
    with pytest.raises(PaymentEvidenceError):
        decode_event(json.dumps(e).encode())


def test_duplicate_json_fields_are_rejected_before_interpretation():
    with pytest.raises(PaymentEvidenceError):
        decode_event(b'{"schema_version":1,"schema_version":1}')


@pytest.mark.parametrize('modify', [
    lambda p:p.update(schema_version=True), lambda p:p.update(ufvk_sha256='f'*64),
    lambda p:p.update(confirmations=2), lambda p:p.update(verified_at=1001),
    lambda p:p.update(valid_until=999), lambda p:p.update(valid_until=2000),
    lambda p:p['event']['payment'].update(value_zatoshis=1),
])
def test_scope_amount_floor_and_freshness_tampering_fail_closed(modify):
    e=event()
    p=proof(copy.deepcopy(e))
    modify(p)
    with patch('dj.apps.g12f.paymentd_protocol.time.time',return_value=1000), \
         patch('dj.apps.g12f.paymentd_protocol.subprocess.run',return_value=SimpleNamespace(stdout=json.dumps(p).encode())):
        with pytest.raises(PaymentEvidenceError):
            verifier().verify(e)


def test_proof_uses_no_shell_or_inherited_credentials_and_matches_all_fields():
    e=event()
    with patch('dj.apps.g12f.paymentd_protocol.time.time',return_value=1000), \
         patch('dj.apps.g12f.paymentd_protocol.subprocess.run',return_value=SimpleNamespace(stdout=json.dumps(proof(e)).encode())) as run:
        assert verifier().verify(e).confirmations == 3
    assert run.call_args.args[0][-2:] == ['verify-event',e['event_id']]
    assert run.call_args.kwargs['env'] == {}
    assert run.call_args.kwargs['timeout'] == 25
    assert run.call_args.kwargs['stdin'] == subprocess.DEVNULL


def test_unapproved_receiver_is_authenticated_for_durable_quarantine():
    e=event()
    e['payment']['recipient_hex']='f'*86
    with patch('dj.apps.g12f.paymentd_protocol.time.time',return_value=1000), \
         patch('dj.apps.g12f.paymentd_protocol.subprocess.run',return_value=SimpleNamespace(stdout=json.dumps(proof(e)).encode())) as run:
        assert verifier().verify(e).receiver_in_scope is False
        run.assert_called_once()


def test_private_config_refuses_symlink_and_world_readable_file(tmp_path):
    path=tmp_path/'private'
    path.write_bytes(b'private')
    os.chmod(path,0o644)
    with pytest.raises(PaymentEvidenceError):
        private_bytes(path)
    os.chmod(path,0o600)
    assert private_bytes(path)==b'private'
    link=tmp_path/'link'
    link.symlink_to(path)
    with pytest.raises(OSError):
        private_bytes(link)


def test_config_subprocess_uses_pinned_namespace_after_original_alias_changes(tmp_path):
    first, second = tmp_path/'first', tmp_path/'second'
    first.mkdir(mode=0o700)
    second.mkdir(mode=0o700)
    for directory in [first, second]:
        config=directory/'config.toml'
        config.write_text('network="main"\nconfirmations=3\nmax_tip_age_seconds=900\n')
        config.chmod(0o600)
    receivers=tmp_path/'receivers.json'
    receivers.write_text(json.dumps(verifier().receivers))
    receivers.chmod(0o600)
    alias=tmp_path/'alias'
    alias.symlink_to(first, target_is_directory=True)
    binary=tmp_path/'proof-binary'
    binary.write_bytes(b'fixture')
    original_lstat=Path.lstat
    def lstat(path, *args, **kwargs):
        if path == binary:
            return SimpleNamespace(st_mode=0o100755, st_uid=0, st_gid=0)
        return original_lstat(path, *args, **kwargs)
    # Bypass only the root-owned binary install; config namespace is real.
    with patch.object(Path,'lstat',lstat), patch('dj.apps.g12f.paymentd_protocol.root_namespace'):
        evidence=LocalEvidence(alias/'config.toml',receivers,binary)
    alias.unlink()
    alias.symlink_to(second, target_is_directory=True)
    e=event()
    with patch('dj.apps.g12f.paymentd_protocol.time.time',return_value=1000), \
         patch('dj.apps.g12f.paymentd_protocol.subprocess.run',return_value=SimpleNamespace(stdout=json.dumps(proof(e)).encode())) as run:
        evidence.verify(e)
    assert run.call_args.args[0][2] == str((first/'config.toml').resolve())
    assert evidence.config_path != (alias/'config.toml').resolve()


def test_config_refuses_writable_parent_even_with_private_leaf(tmp_path):
    parent=tmp_path/'unsafe'
    parent.mkdir(mode=0o777)
    parent.chmod(0o777)
    config=parent/'config.toml'
    config.write_bytes(b'private')
    config.chmod(0o600)
    with pytest.raises(PaymentEvidenceError):
        private_config_path(config)


def historical_proof(e):
    result=proof(e)
    result.pop('event')
    result['record']={key:e[key] for key in ['network','payment','block_height','block_hash','revision']}
    result['record']['confirmed']=True
    return result


def test_historical_proof_keeps_receipt_identity_without_forging_an_event():
    e=event();p=historical_proof(e)
    with patch('dj.apps.g12f.paymentd_protocol.time.time',return_value=1000), \
         patch('dj.apps.g12f.paymentd_protocol.subprocess.run',return_value=SimpleNamespace(stdout=json.dumps(p).encode())) as run:
        assert verifier().verify_payment(e['payment']['id'])==p
    assert run.call_args.args[0][-2:]==['verify-payment',e['payment']['id']]
    assert 'event_id' not in p['record']


@pytest.mark.parametrize('change',[
    lambda p:p['record'].update(network='test'),
    lambda p:p['record']['payment'].update(id='wrong'),
    lambda p:p['record']['payment'].update(memo_hex=''),
    lambda p:p['record']['payment'].update(recipient_hex='e'*86),
    lambda p:p['record'].update(confirmed=1),
    lambda p:p.update(valid_until=999),lambda p:p.update(confirmations=2),
])
def test_historical_proof_scope_hydration_identity_and_freshness_are_required(change):
    e=event();p=historical_proof(e);change(p)
    with patch('dj.apps.g12f.paymentd_protocol.time.time',return_value=1000), \
         patch('dj.apps.g12f.paymentd_protocol.subprocess.run',return_value=SimpleNamespace(stdout=json.dumps(p).encode())):
        with pytest.raises(PaymentEvidenceError): verifier().verify_payment(e['payment']['id'])
