"""Private paymentd evidence validation; no financial writes or memo execution.

A configured local journal supplies provenance. JSON arriving on stdin alone is
never evidence that Zcash arrived. The application also rechecks canonical node
membership before committing a financial effect.
"""
import json
import os
import re
import stat
import time
import tomllib
import subprocess
from dataclasses import dataclass
from pathlib import Path


class PaymentEvidenceError(Exception):
    """Evidence is unavailable, stale, changed or outside the configured scope."""


def _require(condition, message):
    if not condition:
        raise PaymentEvidenceError(message)


def _integer(value, low, high):
    return type(value) is int and low <= value <= high


def _hex(value, length):
    return isinstance(value, str) and re.fullmatch(f'[0-9a-f]{{{length}}}', value) is not None


def _json_no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        _require(key not in result, 'duplicate JSON field')
        result[key] = value
    return result


def decode_event(raw):
    _require(isinstance(raw, bytes) and len(raw) <= 16384, 'event exceeds input bound')
    try:
        e = json.loads(raw, object_pairs_hook=_json_no_duplicates)
    except (ValueError, UnicodeError) as exc:
        raise PaymentEvidenceError('event is not valid JSON') from exc
    fields = {'schema_version', 'journal_sequence', 'event_id', 'kind', 'network',
              'payment', 'block_height', 'block_hash', 'revision'}
    _require(isinstance(e, dict) and set(e) == fields, 'unsupported event fields')
    _require(type(e['schema_version']) is int and e['schema_version'] == 1,
             'unsupported event schema')
    _require(e['network'] == 'main', 'financial adapter requires mainnet')
    _require(e['kind'] in {'payment.observed', 'payment.confirmed', 'payment.revoked'}, 'unsupported lifecycle')
    _require(_integer(e['journal_sequence'], 1, 2**63 - 1)
             and _integer(e['revision'], 1, 2**32 - 1)
             and _integer(e['block_height'], 1, 2**32 - 1)
             and _hex(e['block_hash'], 64), 'invalid event coordinates')
    p = e['payment']
    validate_payment(p)
    identity = f"main:{p['txid']}:{p['pool']}:{p['output_index']}"
    _require(p['id'] == identity and e['event_id'] ==
             f"{identity}:{e['revision']}:{e['kind'].split('.')[1]}", 'event identity changed')
    return e


def validate_payment(p):
    _require(isinstance(p, dict) and set(p) == {'id', 'txid', 'pool', 'output_index',
             'value_zatoshis', 'memo_hex', 'recipient_hex'}, 'unsupported payment fields')
    _require(_hex(p['txid'], 64) and p['pool'] in {'sapling', 'orchard', 'ironwood'}
             and _integer(p['output_index'], 0, 2**32 - 1)
             and _integer(p['value_zatoshis'], 0, 21_000_000 * 100_000_000)
             and _hex(p['memo_hex'], 1024) and _hex(p['recipient_hex'], 86),
             'invalid shielded payment')
    _require(p['id'] == f"main:{p['txid']}:{p['pool']}:{p['output_index']}", 'payment identity changed')


def validate_record(record):
    _require(isinstance(record, dict) and set(record) == {'network','payment','block_height','block_hash','revision','confirmed'},
             'unsupported historical receipt fields')
    validate_payment(record['payment'])
    _require(record['network'] == 'main' and type(record['confirmed']) is bool
             and _integer(record['block_height'], 1, 2**32-1)
             and _integer(record['revision'], 1, 2**32-1) and _hex(record['block_hash'], 64),
             'invalid historical receipt')


def private_bytes(path):
    path = Path(path)
    _require(path.is_absolute(), 'private path must be absolute')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        _require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
                 and stat.S_IMODE(info.st_mode) == 0o600, 'private file ownership/mode differs')
        with os.fdopen(fd, 'rb', closefd=False) as source:
            data = source.read(65537)
        _require(len(data) <= 65536, 'private file exceeds input bound')
        return data
    finally:
        os.close(fd)


def private_config_path(path):
    """Pin the namespace passed to Rust, rather than reopen an original alias."""
    path = Path(path)
    _require(path.is_absolute() and not path.is_symlink(), 'config path must be absolute and non-symlink')
    canonical = path.resolve(strict=True)
    for parent in canonical.parents:
        info = parent.lstat()
        # Root's sticky temporary namespace cannot replace another user's entry.
        sticky_tmp = info.st_uid == 0 and bool(info.st_mode & stat.S_ISVTX)
        _require(stat.S_ISDIR(info.st_mode) and info.st_uid in {0, os.geteuid()}
                 and (not info.st_mode & 0o022 or sticky_tmp),
                 'config has an untrusted or writable parent namespace')
    return canonical


@dataclass(frozen=True)
class Evidence:
    event: dict
    config: dict
    # Canonical confirmations computed by the node, not claimed by event stdin.
    confirmations: int
    receiver_in_scope: bool


class LocalEvidence:
    """Use the pinned Rust observer's typed provider and read-only journal proof."""
    def __init__(self, config_path, receiver_path, binary):
        self.config_path = private_config_path(config_path)
        self.config = tomllib.loads(private_bytes(self.config_path).decode())
        self.receivers = json.loads(private_bytes(private_config_path(receiver_path)), object_pairs_hook=_json_no_duplicates)
        self.binary = Path(binary)
        info = self.binary.lstat()
        _require(self.binary.is_absolute() and stat.S_ISREG(info.st_mode)
                 and info.st_uid == 0 and info.st_gid == 0 and stat.S_IMODE(info.st_mode) & 0o022 == 0,
                 'proof executable must be a root-owned immutable regular file')
        root_namespace(self.binary)
        c = self.config
        _require(c['network'] == 'main' and _integer(c['confirmations'], 3, 1000),
                 'financial confirmation policy requires mainnet and at least three blocks')
        _require(set(self.receivers) == {'ufvk_sha256', 'receivers'}
                 and _hex(self.receivers['ufvk_sha256'], 64), 'receiver scope is invalid')
        allowed = self.receivers['receivers']
        _require(isinstance(allowed, dict) and set(allowed) <= {'sapling', 'orchard', 'ironwood'}
                 and all(isinstance(values, list) and values and all(_hex(v, 86) for v in values)
                         for values in allowed.values()), 'receiver allowlist is invalid')


    def _proof(self, command, identity):
        try:
            result = subprocess.run([str(self.binary), '--config', str(self.config_path), command, identity],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                env={}, cwd='/', timeout=25, check=True)
            _require(len(result.stdout) <= 16384, 'payment proof exceeds input bound')
            return json.loads(result.stdout, object_pairs_hook=_json_no_duplicates)
        except (OSError, subprocess.SubprocessError, ValueError) as exc:
            raise PaymentEvidenceError('payment proof is unavailable') from exc

    def _validate_proof(self, proof, field):
        now = int(time.time())
        fields = {'schema_version', field, 'confirmations', 'ufvk_sha256', 'verified_at', 'valid_until'}
        _require(isinstance(proof, dict) and set(proof) == fields
                 and type(proof.get('schema_version')) is int and proof['schema_version'] == 1
                 and proof.get('ufvk_sha256') == self.receivers['ufvk_sha256']
                 and _integer(proof.get('verified_at'), now - 25, now)
                 and _integer(proof.get('valid_until'), now, 2**63 - 1)
                 and _integer(proof.get('confirmations'), 0, 2**32 - 1),
                 'payment proof is changed, outside scope or expired')
        _require(proof['verified_at'] <= proof['valid_until'] <=
                 proof['verified_at'] + self.config.get('max_tip_age_seconds', 900),
                 'payment proof freshness deadline is invalid')
        body = proof[field]
        _require(isinstance(body, dict) and isinstance(body.get('payment'), dict), 'invalid payment proof body')
        p = body['payment']
        validate_payment(p)

    def verify(self, event):
        # Authenticate every queued UFVK note before classifying its receiver.
        # An omitted diversified receiver must reach durable quarantine rather
        # than permanently occupy a consumer's FIFO head.
        proof = self._proof('verify-event', event['event_id'])
        self._validate_proof(proof, 'event')
        _require(proof['event'] == event, 'event proof differs from delivery')
        if event['kind'] == 'payment.confirmed':
            _require(proof['confirmations'] >= self.config['confirmations'], 'payment lacks financial confirmation depth')
        if event['kind'] == 'payment.revoked':
            _require(proof['confirmations'] == 0, 'revocation cannot claim present confirmation depth')
        p = event['payment']
        return Evidence(event, self.config, proof['confirmations'],
            p['recipient_hex'] in self.receivers['receivers'].get(p['pool'], []))

    def verify_payment(self, payment_id):
        _require(isinstance(payment_id, str) and len(payment_id) <= 128, 'invalid payment identity')
        proof = self._proof('verify-payment', payment_id)
        self._validate_proof(proof, 'record')
        validate_record(proof['record'])
        p = proof['record']['payment']
        _require(p['recipient_hex'] in self.receivers['receivers'].get(p['pool'], []),
                 'historical payment receiver requires operator resolution')
        _require(proof['record']['payment']['id'] == payment_id, 'historical identity differs')
        if proof['record']['confirmed']:
            _require(proof['confirmations'] >= self.config['confirmations'], 'historical payment lost depth')
        return proof


def root_namespace(path):
    for parent in Path(path).parents:
        info = parent.lstat()
        _require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and info.st_gid == 0
                 and info.st_mode & 0o022 == 0,
                 'root artifact has a writable or symlink parent namespace')
