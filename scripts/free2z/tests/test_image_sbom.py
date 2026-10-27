import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('image_sbom', ROOT / 'scripts/free2z/prepare-image-sbom.py')
sbom = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sbom)
IMAGE = 'sha256:' + 'a' * 64


def document():
    return {
        'spdxVersion': 'SPDX-2.3', 'dataLicense': 'CC0-1.0', 'SPDXID': 'SPDXRef-DOCUMENT',
        'name': 'fixture', 'documentNamespace': 'https://example.invalid/sbom/fixture',
        'creationInfo': {'created': '2026-10-27T00:00:00Z', 'creators': ['Tool: syft-1.38.0']},
        'documentDescribes': ['SPDXRef-image-long-name'],
        'packages': [
            {'SPDXID': 'SPDXRef-image-long-name', 'name': 'fixture', 'downloadLocation': 'NOASSERTION',
             'primaryPackagePurpose': 'CONTAINER', 'checksums': [{'algorithm': 'SHA256', 'checksumValue': 'a' * 64}]},
            {'SPDXID': 'SPDXRef-package-long-name', 'name': 'SPDXRef-file-long-name', 'versionInfo': '1.0',
             'downloadLocation': 'NOASSERTION', 'hasFiles': ['SPDXRef-file-long-name'],
             'licenseDeclared': 'LicenseRef-custom', 'comment': 'SPDXRef-package-long-name'}],
        'files': [{'SPDXID': 'SPDXRef-file-long-name', 'fileName': 'SPDXRef-package-long-name',
                   'fileDependencies': ['SPDXRef-file-long-name'],
                   'checksums': [{'algorithm': 'SHA256', 'checksumValue': 'b' * 64}]}],
        'hasExtractedLicensingInfos': [{'licenseId': 'LicenseRef-custom', 'extractedText': 'SPDXRef-file-long-name'}],
        'relationships': [
            {'spdxElementId': 'SPDXRef-DOCUMENT', 'relationshipType': 'DESCRIBES', 'relatedSpdxElement': 'SPDXRef-image-long-name'},
            {'spdxElementId': 'SPDXRef-image-long-name', 'relationshipType': 'CONTAINS', 'relatedSpdxElement': 'SPDXRef-package-long-name'},
            {'spdxElementId': 'SPDXRef-package-long-name', 'relationshipType': 'CONTAINS', 'relatedSpdxElement': 'SPDXRef-file-long-name', 'comment': 'SPDXRef-file-long-name'},
            {'spdxElementId': 'SPDXRef-file-long-name', 'relationshipType': 'OTHER', 'relatedSpdxElement': 'NOASSERTION'}]}


class ImageSBOM(unittest.TestCase):
    def test_lossless_bijection_every_supported_reference_and_unchanged_metadata(self):
        original = document()
        result = json.loads(sbom.prepare(original))
        inverse = {new['SPDXID']: old['SPDXID'] for group in ('packages', 'files')
                   for old, new in zip(original[group], result[group], strict=True)}
        # Independently restore all supported locations (not the implementation's walker).
        for group, refs in (('packages', 'hasFiles'), ('files', 'fileDependencies')):
            for item in result[group]:
                item['SPDXID'] = inverse[item['SPDXID']]
                if refs in item:
                    item[refs] = [inverse[v] for v in item[refs]]
        result['documentDescribes'] = [inverse[v] for v in result['documentDescribes']]
        for relation in result['relationships']:
            for key in ('spdxElementId', 'relatedSpdxElement'):
                relation[key] = inverse.get(relation[key], relation[key])
        self.assertEqual(result, original)
        self.assertEqual(original, document())

    def test_id_collision_with_normalized_names_remains_bijective(self):
        value = document()
        sbom.replace_ids(value, {'SPDXRef-package-long-name': 'SPDXRef-0'})
        result = json.loads(sbom.prepare(value))
        self.assertEqual(len({p['SPDXID'] for p in result['packages']}), 2)

    def test_binding_checks_config_and_every_predicate_byte(self):
        doc = document()
        encoded = sbom.prepare(doc)
        # Source manifest is a different identity from the Docker config.
        config = 'sha256:' + 'c' * 64
        recorded = sbom.binding(doc, encoded, config)
        self.assertEqual(recorded['syft_source_manifest_digest'], IMAGE)
        sbom.check_binding(doc, encoded, config, recorded)
        for bad_image, bad_bytes in ((IMAGE, encoded), (config, encoded + b' ')):
            with self.assertRaises(ValueError):
                sbom.check_binding(doc, bad_bytes, bad_image, recorded)
        for key in recorded:
            changed = dict(recorded)
            changed[key] = 'wrong'
            with self.assertRaises(ValueError):
                sbom.check_binding(doc, encoded, config, changed)

    def test_malformed_or_unsupported_inventory_fails(self):
        mutations = [
            lambda d: d.update(spdxVersion='SPDX-3.0'),
            lambda d: d.update(snippets=[]),
            lambda d: d.update(externalDocumentRefs=[]),
            lambda d: d.update(packages=[]),
            lambda d: d['files'][0].update(SPDXID=d['packages'][0]['SPDXID']),
            lambda d: d['files'][0].update(SPDXID='invalid id'),
            lambda d: d['relationships'][1].update(relatedSpdxElement='SPDXRef-absent'),
            lambda d: d['relationships'][1].update(spdxElementId='NOASSERTION'),
            lambda d: d['packages'][1].update(hasFiles=['SPDXRef-image-long-name']),
            lambda d: d['files'][0].update(fileDependencies=['SPDXRef-image-long-name']),
            lambda d: d['packages'][1].update(annotations=[{'SPDXID': 'SPDXRef-unknown'}]),
            lambda d: d['packages'][1].update(snippetFromFile='SPDXRef-file-long-name'),
            lambda d: d['packages'][1].update(ranges=[{'reference': 'SPDXRef-file-long-name'}]),
            lambda d: d['relationships'].pop(0),
            lambda d: d['packages'][1].update(primaryPackagePurpose='CONTAINER'),
            lambda d: d['packages'][0].update(checksums=[]),
            lambda d: d.update(documentDescribes=['SPDXRef-package-long-name']),
            lambda d: d['packages'][1].pop('name'),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                value = document()
                mutate(value)
                with self.assertRaises((ValueError, KeyError)):
                    sbom.prepare(value)

    def test_real_limit_is_exact_bytes_and_never_truncates(self):
        value = document()
        value['comment'] = ''
        base = len(sbom.prepare(value))
        value['comment'] = 'x' * (sbom.MAX_PREDICATE_BYTES - base)
        self.assertEqual(len(sbom.prepare(value)), 16 * 1024 * 1024)
        value['comment'] += 'é'  # UTF-8 bytes, not character count.
        original = copy.deepcopy(value)
        with self.assertRaisesRegex(ValueError, 'must not be truncated'):
            sbom.prepare(value)
        self.assertEqual(value, original)

    def test_input_duplicate_keys_nonfinite_oversize_and_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'input.json'
            for content in ('{"name":1,"name":2}', '{"value":NaN}'):
                path.write_text(content)
                with self.assertRaises(ValueError):
                    sbom.load(path, 1024)
            path.write_text('{}')
            with self.assertRaises(ValueError):
                sbom.load(path, 1)
            link = Path(directory) / 'link.json'
            link.symlink_to(path)
            with self.assertRaises(ValueError):
                sbom.load(link, 1024)


if __name__ == '__main__':
    unittest.main()
