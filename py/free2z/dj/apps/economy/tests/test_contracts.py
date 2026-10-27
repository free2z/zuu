"""Published resource integrity and the boundary future adapters consume."""
from decimal import Decimal
from hashlib import sha256
from pathlib import Path
import subprocess
import sys

import pytest

from dj.apps.economy import contracts
from dj.apps.pricing.constants import USD_PER_TUZI


def test_published_version_bytes_are_frozen():
    # A changed text is a new version. Do not "repair" these hashes after
    # publishing: retained actual acceptances must continue to resolve.
    record = contracts.creator_contract('cc-2026-10-v1',
        '6d4d6ad368ad9971be9b5a714ed25ab028c5a40caeb6b7ad47880bfd2efc3478')
    assert record is not None
    assert record['payment_method_version'] == 'zec-spot-2026-10-v1'
    assert record['payment_method_digest'] == '9f957900185ca8fec51fff61cade273bb82759d236288083fbf1733bb0e7c2d5'
    assert contracts.USAGE_RETAIL_VERSION == 'usage-retail-v1'
    assert contracts.USAGE_RETAIL_DIGEST == 'dbf4ab8f688996fbe3f05a2ecf4e2372f2ad914cc1d83481ed0c56b6e48f8c77'
    assert contracts.zec_funding_method('zec-funding-v1')['digest'] == '0ae3c21a68c35378001006476c2c2fb45500cfe3397bad6ca00c08f199e06b88'
    for service, version, digest in (
        ('livestream_ppv', 'livestream-ppv-2026-10-v1',
         'ae771ef4a00bf30a6756cad6f703af020697851bba171321fc2de100078a23fd'),
        ('sdk_application', 'sdk-application-2026-10-v1',
         '3fbd270aa5d4737a98b6bd6514dd24ad4cf86d40e0fcb0917ef3c9852d67f664'),
        ('subscription_access', 'subscription-access-2026-10-v1',
         'b868761b030c492f8e183a2d16af23c96e4463ef53b3ccbe55cfc674379b247d'),
    ):
        assert contracts.published_schedule(service, version)['digest'] == digest


def test_contract_acceptance_covers_exact_payment_method():
    record = contracts.creator_contract(
        contracts.CREATOR_CONTRACT_VERSION, contracts.CREATOR_CONTRACT_DIGEST)
    assert record['text'].count(record['payment_method_text']) == 1
    assert record['payment_method_digest'] == sha256(
        record['payment_method_text'].encode('utf-8')).hexdigest()
    assert record['payment_method_version'] in record['payment_method_text']
    assert contracts.creator_contract(record['version'], '0' * 64) is None
    assert contracts.creator_contract('unknown', record['digest']) is None
    with pytest.raises(TypeError):
        record['text'] = 'replacement'


def test_published_schedule_lookup_cannot_bless_arbitrary_row():
    expected = {
        'livestream_ppv': 'livestream-ppv-2026-10-v2',
        'sdk_application': 'sdk-application-2026-10-v2',
    }
    assert set(contracts.SERVICE_SCHEDULES) == set(expected)
    for service, version in expected.items():
        record = contracts.published_schedule(service, version)
        assert record is contracts.published_schedule(service)
        assert record['service'] == service
        assert record['version'] == version
        assert record['contract_version'] == contracts.CREATOR_CONTRACT_VERSION
        assert record['digest'] == sha256(record['text'].encode('utf-8')).hexdigest()
        assert version in record['text']
        assert contracts.published_schedule(service, 'unpublished') is None
        # These are shared authoritative resources. A consumer must not be
        # able to rewrite a rate/version and leave another adapter believing it.
        with pytest.raises(TypeError):
            record['rate_nusd_per_allocated_m2z'] = 1
    for excluded in ('donation', 'subscription_access', 'sharing', 'e2ee_tip', 'unknown'):
        assert contracts.published_schedule(excluded) is None
    with pytest.raises(TypeError):
        contracts.SERVICE_SCHEDULES['donation'] = {}


def test_service_rate_matches_current_nominal_unit_price_without_fee_change():
    for record in contracts.SERVICE_SCHEDULES.values():
        assert Decimal(record['rate_nusd_per_allocated_m2z']) / Decimal(10**9) == USD_PER_TUZI / 1000
    assert 'USD 0.01 per tuzi' in contracts.USAGE_RETAIL_TEXT
    assert 'USD 0.000010000' in contracts.USAGE_RETAIL_TEXT


def test_digest_commits_exact_bytes_including_newline():
    for text, digest in (
        (contracts.CREATOR_CONTRACT_TEXT, contracts.CREATOR_CONTRACT_DIGEST),
        (contracts.PAYMENT_METHOD_TEXT, contracts.PAYMENT_METHOD_DIGEST),
        (contracts.USAGE_RETAIL_TEXT, contracts.USAGE_RETAIL_DIGEST),
    ):
        assert text.endswith('\n')
        assert sha256(text.encode('utf-8')).hexdigest() == digest
        assert contracts.text_digest(text[:-1]) != digest


def test_canonical_resource_loads_without_django_or_external_text_artifact():
    # -S disables site packages; only the shipped Python source is present.
    # This catches an accidental import of Django/services or a local-only
    # text file dependency before every product consumer depends on it.
    python_root = Path(__file__).resolve().parents[4]
    result = subprocess.run([
        sys.executable, '-S', '-c',
        'import sys; sys.path.insert(0, sys.argv[1]); '
        'from dj.apps.economy.contracts import CREATOR_CONTRACT_TEXT; '
        'assert "surviving" in CREATOR_CONTRACT_TEXT; '
        'assert "django" not in sys.modules', str(python_root),
    ], capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr


def test_current_scope_preserves_previous_versions_without_offering_them():
    assert contracts.CREATOR_CONTRACT_VERSION == 'cc-2026-10-v2'
    assert contracts.CREATOR_CONTRACT_DIGEST == 'aa237c3a7f18c5569aea6ce5d48aed2af4ff6efffec65a185b766c079daedad0'
    assert 'subscriptions, memberships' in contracts.CREATOR_CONTRACT_TEXT
    assert contracts.published_schedule('subscription_access') is None
    previous = contracts.published_schedule('subscription_access', 'subscription-access-2026-10-v1')
    assert previous['contract_version'] == 'cc-2026-10-v1'
    for service, digest in (
        ('livestream_ppv', '643f853012f4756c2c2ba118845fcf55f82e0c97e328ac3d0d65afd217b1f550'),
        ('sdk_application', 'acd073acf91613df8eef5e5c4548766c744e9d7fe344c05f4d7b62a56802b59f'),
    ):
        assert contracts.published_schedule(service)['digest'] == digest


def test_public_legal_documents_match_exact_current_resources_and_retain_v1():
    root = Path(__file__).resolve().parents[6]
    for name in ('docs/about-free2z/docs/legal/06-revenue-share-agreement.md', 'new-docs/legal/creator-compensation.md'):
        document = (root/name).read_text()
        links_to_current_terms = '(https://free2z.cash/api/economy/agreement/)' in document
        if not links_to_current_terms:
            assert f'```text\n{contracts.CREATOR_CONTRACT_TEXT}```' in document
            for schedule in contracts.SERVICE_SCHEDULES.values():
                assert f"```text\n{schedule['text']}```" in document
        assert 'subscription-access-2026-10-v1' not in document
    previous = contracts.creator_contract('cc-2026-10-v1', '6d4d6ad368ad9971be9b5a714ed25ab028c5a40caeb6b7ad47880bfd2efc3478')
    retained = (root/'docs/legal/history/canonical-cc-2026-10-v1.md').read_text()
    assert f"```text\n{previous['text']}```" in retained
    assert contracts.published_schedule('subscription_access', 'subscription-access-2026-10-v1')['text'] in retained


def test_unavailable_retail_method_is_retained_without_public_purchase_offer():
    root = Path(__file__).resolve().parents[6]
    archive = (root/'docs/legal/history/usage-retail-v1.md').read_text()
    assert f'```text\n{contracts.USAGE_RETAIL_TEXT}```' in archive
    for name in ('docs/about-free2z/docs/legal/05-token-sale-and-usage-terms.md', 'new-docs/legal/usage-credits.md'):
        public = (root/name).read_text()
        assert contracts.USAGE_RETAIL_TEXT not in public
        assert 'Buying platform usage credits is an independent purchase' in public


def test_funding_matching_method_preserves_original_signed_method_history():
    original = contracts.zec_funding_method('zec-funding-v1')
    current = contracts.zec_funding_method(contracts.ZEC_FUNDING_VERSION, contracts.ZEC_FUNDING_DIGEST)
    assert contracts.ZEC_FUNDING_VERSION == 'zec-funding-v3'
    retained = contracts.zec_funding_method('zec-funding-v2')
    assert retained['digest'] == 'faa147f22adab5567ca3fb9594857657266dbf31617f29d33b5556d3c3994cd9'
    assert 'stored random purchase matching token' in retained['text']
    assert 'signed intent memo' in original['text']
    assert 'estimates' in current['text'] and 'fresh recorded multi-source' in current['text']
    assert 'matching token' not in current['text']
    assert current['digest'] == contracts.text_digest(current['text'])
    assert contracts.zec_funding_method('unknown') is None
    assert contracts.zec_funding_method('zec-funding-v1', current['digest']) is None
    with pytest.raises(TypeError):
        original['text'] = current['text']



def test_public_funding_method_mirrors_current_bytes_and_archives_original():
    root = Path(__file__).resolve().parents[6]
    for name in ('docs/about-free2z/docs/legal/05-token-sale-and-usage-terms.md', 'new-docs/legal/usage-credits.md'):
        document = (root/name).read_text()
        assert f'```text\n{contracts.ZEC_FUNDING_TEXT}```' in document
        assert contracts.ZEC_FUNDING_DIGEST in document
    old = contracts.zec_funding_method('zec-funding-v1')
    retained = (root/'docs/legal/history/zec-funding-v1.md').read_text()
    assert f"```text\n{old['text']}```" in retained
    assert old['digest'] in retained


def test_retired_v2_funding_terms_remain_byte_exact():
    root = Path(__file__).resolve().parents[6]
    record = contracts.zec_funding_method('zec-funding-v2')
    assert f"```text\n{record['text']}```" in (root/'docs/legal/history/zec-funding-v2.md').read_text()
