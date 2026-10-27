"""Fixed cross-implementation signature contracts; no wallet, node or database.

The committed fixtures include an existing Rust wallet-plugin signature and
OpenSSL-generated signatures for public test scalars 1/2. Expected digests and
addresses were encoded independently of the application. Tests never sign or
use python-ecdsa; the removed implementation's differential evidence is in
's review. Run this file directly with unittest for a native-image smoke.
"""
import base64
import json
from pathlib import Path
import unittest

from dj.apps.zauth import verify


FIXTURES = json.loads(
    Path(__file__).with_name('fixtures').joinpath('recovery_vectors.json').read_text()
)
ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141


class RecoveryCompatibilityTests(unittest.TestCase):
    def test_independent_message_framing_and_addresses(self):
        for vector in FIXTURES['valid']:
            with self.subTest(vector=vector['name']):
                message = vector['text'] * vector['repeat']
                self.assertEqual(verify.message_digest(message).hex(), vector['digest'])
                self.assertEqual(
                    verify.p2pkh_address(bytes.fromhex(vector['pubkey'])),
                    vector['address'],
                )

    def test_fixed_wallet_and_openssl_signatures(self):
        for vector in FIXTURES['valid']:
            with self.subTest(vector=vector['name']):
                self.assertTrue(verify.verify_message(
                    vector['address'], vector['signature'],
                    vector['text'] * vector['repeat'],
                ))

    def test_both_s_forms_and_header_compression_variants(self):
        parities = set()
        for vector in FIXTURES['valid']:
            raw = base64.b64decode(vector['signature'])
            recovery_id = (raw[0] - 27) & 3
            scalar = int.from_bytes(raw[33:], 'big')
            for flip in (False, True):
                # (r, n-s) represents the same signature with opposite recovery
                # parity. Both are accepted; recovery must not enforce low-S.
                parity = recovery_id ^ flip
                parities.add(parity)
                s = ORDER - scalar if flip else scalar
                for header_offset in (27, 31):
                    with self.subTest(vector=vector['name'], flip=flip, header=header_offset):
                        signature = bytes([header_offset + parity]) + raw[1:33] + s.to_bytes(32, 'big')
                        self.assertTrue(verify.verify_message(
                            vector['address'], base64.b64encode(signature).decode(),
                            vector['text'] * vector['repeat'],
                        ))
        self.assertEqual(parities, {0, 1})

    def test_wrong_message_address_and_parity_fail_closed(self):
        for vector in FIXTURES['valid']:
            message = vector['text'] * vector['repeat']
            raw = base64.b64decode(vector['signature'])
            wrong_parity = bytes([27 + (((raw[0] - 27) & 3) ^ 1)]) + raw[1:]
            with self.subTest(vector=vector['name']):
                self.assertFalse(verify.verify_message(vector['address'], vector['signature'], message + '!'))
                self.assertFalse(verify.verify_message('t1WnCauSV6fbHzWBHtSrK2qvFRyU6J121nH', vector['signature'], message))
                self.assertFalse(verify.verify_message(vector['address'], base64.b64encode(wrong_parity).decode(), message))

    def test_recoverable_ids_two_and_three_stay_rejected(self):
        # Each fixture has a real recoverable public key under its ID. Merely
        # changing the header of a normal signature would not catch widening
        # the protocol: it usually fails native recovery for unrelated reasons.
        for vector in FIXTURES['unsupported_recovery_ids']:
            raw = base64.b64decode(vector['signature'])
            for offset in (27, 31):
                with self.subTest(id=vector['recovery_id'], offset=offset):
                    signature = bytes([offset + vector['recovery_id']]) + raw[1:]
                    self.assertFalse(verify.verify_message(
                        vector['address'], base64.b64encode(signature).decode(), vector['message'],
                    ))

    def test_invalid_scalars_are_rejected_even_for_formerly_recovered_address(self):
        # Intentional tightening: the old recovery-only implementation accepted
        # these encodings for the given synthetic address. They are not valid
        # ECDSA signatures (1 <= r,s < n), regardless of recoverable points.
        for vector in FIXTURES['invalid_scalars']:
            with self.subTest(r=vector['r'], s=vector['s']):
                self.assertFalse(verify.verify_message(
                    vector['address'], vector['signature'], vector['message'],
                ))

    def test_malformed_encoding_and_scalar_boundaries_fail_closed(self):
        vector = FIXTURES['valid'][0]
        raw = base64.b64decode(vector['signature'])
        signatures = ['', 'not-base64!!', vector['signature'] + '\n']
        for malformed in (raw[:-1], raw + b'\x00', b''):
            signatures.append(base64.b64encode(malformed).decode())
        for header in (0, 26, 35, 255):
            signatures.append(base64.b64encode(bytes([header]) + raw[1:]).decode())
        for r, s in ((0, 1), (1, 0), (ORDER, 1), (1, ORDER), (2**256-1, 1), (1, 2**256-1)):
            signatures.append(base64.b64encode(bytes([31]) + r.to_bytes(32, 'big') + s.to_bytes(32, 'big')).decode())
        for signature in signatures:
            with self.subTest(signature=signature):
                self.assertFalse(verify.verify_message(vector['address'], signature, ''))


if __name__ == '__main__':
    unittest.main()
