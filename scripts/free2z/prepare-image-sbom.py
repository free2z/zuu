#!/usr/bin/env python3
"""Preserve a Syft SPDX inventory while shortening document-local identifiers.

The pinned attestation action accepts at most 16 MiB per predicate. This adapter
supports the Syft SPDX 2.3 package/file profile; unsupported document structures
fail closed. It is a bounded profile validator, not a general SPDX validator.
Only identifiers and their schema-defined references change. The original JSON
must be exactly recoverable through the inverse identifier mapping.
"""
import argparse
import copy
import json
import hashlib
import re
from pathlib import Path

MAX_PREDICATE_BYTES = 16 * 1024 * 1024
MAX_SOURCE_BYTES = 128 * 1024 * 1024
ID = re.compile(r'SPDXRef-[A-Za-z0-9.-]+\Z')
IMAGE_ID = re.compile(r'sha256:[a-f0-9]{64}\Z')
TOP_KEYS = {'spdxVersion', 'dataLicense', 'SPDXID', 'name', 'documentNamespace',
            'creationInfo', 'packages', 'files', 'hasExtractedLicensingInfos',
            'relationships', 'documentDescribes', 'annotations', 'comment'}
# SPDX 2.3 reference fields: package.hasFiles, file.fileDependencies,
# document.documentDescribes, and both relationship endpoints. Snippet references
# (snippetFromFile / ranges.reference) and external documents are unsupported.
REFERENCE_KEYS = {'SPDXID', 'spdxElementId', 'relatedSpdxElement', 'documentDescribes',
                  'hasFiles', 'fileDependencies', 'snippetFromFile', 'reference'}


def object_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate JSON key: ' + key)
        result[key] = value
    return result


def load(path, limit):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > limit:
        raise ValueError('SBOM must be a bounded regular file')
    return json.loads(path.read_bytes(), object_pairs_hook=object_pairs,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))


def string(value):
    if not isinstance(value, str) or not value:
        raise ValueError('expected a nonempty SPDX string')
    return value


def objects(value):
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise ValueError('expected an SPDX object array')
    return value


def reference_slots(doc):
    """Yield only schema-defined identifier locations, never arbitrary strings."""
    yield doc, 'SPDXID'
    for collection in ('packages', 'files'):
        for item in doc.get(collection, []):
            yield item, 'SPDXID'
            key = 'hasFiles' if collection == 'packages' else 'fileDependencies'
            if key in item:
                if not isinstance(item[key], list):
                    raise ValueError('expected SPDX reference array')
                for index in range(len(item[key])):
                    yield item[key], index
    for relation in doc['relationships']:
        yield relation, 'spdxElementId'
        yield relation, 'relatedSpdxElement'
    if 'documentDescribes' in doc:
        if not isinstance(doc['documentDescribes'], list):
            raise ValueError('expected SPDX reference array')
        for index in range(len(doc['documentDescribes'])):
            yield doc['documentDescribes'], index


def validate(doc):
    if not isinstance(doc, dict) or set(doc) - TOP_KEYS:
        raise ValueError('unsupported SPDX document structure')
    if doc.get('spdxVersion') != 'SPDX-2.3' or doc.get('dataLicense') != 'CC0-1.0' or doc.get('SPDXID') != 'SPDXRef-DOCUMENT':
        raise ValueError('expected SPDX 2.3 document')
    for key in ('name', 'documentNamespace'):
        string(doc.get(key))
    info = doc.get('creationInfo')
    if not isinstance(info, dict) or not isinstance(info.get('creators'), list) or not info['creators']:
        raise ValueError('missing SPDX creation identity')
    string(info.get('created'))
    for creator in info['creators']:
        string(creator)
    packages = objects(doc.get('packages'))
    files = objects(doc.get('files', []))
    relationships = objects(doc.get('relationships'))
    if len(packages) < 2 or not relationships:
        raise ValueError('SBOM must contain an image and its package inventory')
    elements = [doc, *packages, *files]
    identifiers = [string(item.get('SPDXID')) for item in elements]
    if any(not ID.fullmatch(value) for value in identifiers) or len(set(identifiers)) != len(identifiers):
        raise ValueError('SPDX identifiers must be legal and unique')
    slots = list(reference_slots(doc))
    known_slots = {(id(container), key) for container, key in slots}

    def walk(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key in REFERENCE_KEYS and (id(value), key) not in known_slots:
                    # Arrays have their elements registered individually above.
                    allowed_array = ((value is doc and key == 'documentDescribes') or
                                     (any(value is p for p in packages) and key == 'hasFiles') or
                                     (any(value is f for f in files) and key == 'fileDependencies'))
                    if not allowed_array:
                        raise ValueError('unsupported SPDX reference location: ' + key)
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)
    walk(doc)
    known = set(identifiers)
    for container, key in slots:
        value = string(container[key])
        if value not in known and not (key == 'relatedSpdxElement' and value in ('NONE', 'NOASSERTION')):
            raise ValueError('dangling or external SPDX reference: ' + value)
    file_ids = {item['SPDXID'] for item in files}
    for package in packages:
        string(package.get('name'))
        string(package.get('downloadLocation'))
        if any(value not in file_ids for value in package.get('hasFiles', [])):
            raise ValueError('package file reference is not a file')
    for item in files:
        string(item.get('fileName'))
        if any(value not in file_ids for value in item.get('fileDependencies', [])):
            raise ValueError('file dependency is not a file')
    for item in [*packages, *files]:
        for checksum in objects(item.get('checksums', [])):
            string(checksum.get('algorithm'))
            string(checksum.get('checksumValue'))
    for relation in relationships:
        string(relation.get('relationshipType'))
    described = [r['relatedSpdxElement'] for r in relationships
                 if r['spdxElementId'] == doc['SPDXID'] and r['relationshipType'] == 'DESCRIBES']
    roots = [p for p in packages if p.get('primaryPackagePurpose') == 'CONTAINER']
    if len(roots) != 1 or described != [roots[0]['SPDXID']]:
        raise ValueError('SBOM must describe exactly one container image')
    if 'documentDescribes' in doc and doc['documentDescribes'] != described:
        raise ValueError('inconsistent described image')
    sha256 = [c['checksumValue'] for c in roots[0].get('checksums', []) if c['algorithm'] == 'SHA256']
    if len(sha256) != 1 or not IMAGE_ID.fullmatch('sha256:' + sha256[0]):
        raise ValueError('SBOM image source must contain one SHA256 manifest digest')
    return identifiers


def replace_ids(doc, mapping):
    for container, key in reference_slots(doc):
        container[key] = mapping.get(container[key], container[key])


def prepare(doc):
    identifiers = validate(doc)
    mapping = {old: f'SPDXRef-{index}' for index, old in enumerate(identifiers[1:])}
    result = copy.deepcopy(doc)
    replace_ids(result, mapping)
    validate(result)
    restored = copy.deepcopy(result)
    replace_ids(restored, {new: old for old, new in mapping.items()})
    if restored != doc:
        raise ValueError('SPDX normalization changed inventory evidence')
    encoded = json.dumps(result, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8') + b'\n'
    if len(encoded) > MAX_PREDICATE_BYTES:
        raise ValueError('complete normalized SBOM exceeds the 16 MiB attestation limit; inventory must not be truncated')
    return encoded


def binding(doc, encoded, image_id):
    if not IMAGE_ID.fullmatch(image_id):
        raise ValueError('expected Docker image configuration SHA256')
    root = next(p for p in doc['packages'] if p.get('primaryPackagePurpose') == 'CONTAINER')
    source_digest = next(c['checksumValue'] for c in root['checksums'] if c['algorithm'] == 'SHA256')
    # Syft's source manifest can differ from the registry manifest after Docker
    # save/load/push conversion. Never relabel that checksum as a config digest.
    return {'schema_version': 1, 'image_config_digest': image_id,
            'syft_source_manifest_digest': 'sha256:' + source_digest,
            'predicate_sha256': hashlib.sha256(encoded).hexdigest()}


def check_binding(doc, encoded, image_id, recorded):
    if not isinstance(recorded, dict) or type(recorded.get('schema_version')) is not int or recorded != binding(doc, encoded, image_id):
        raise ValueError('SBOM bytes or loaded image configuration differ from checked build')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('prepare', 'check'))
    parser.add_argument('source', type=Path)
    parser.add_argument('--image-id', required=True)
    parser.add_argument('--image-config', type=Path)
    parser.add_argument('--binding', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    doc = load(args.source, MAX_SOURCE_BYTES if args.mode == 'prepare' else MAX_PREDICATE_BYTES)
    validate(doc)
    if args.mode == 'prepare':
        if args.output is None or args.output.exists() or args.binding.exists():
            parser.error('prepare requires new predicate and binding output paths')
        if args.image_config is None or args.image_config.is_symlink() or args.image_config.stat().st_size > 72 or args.image_config.read_text().strip() != args.image_id:
            raise ValueError('candidate image changed during SBOM generation')
        data = prepare(doc)
        metadata = binding(doc, data, args.image_id)
        with args.output.open('xb') as output:
            output.write(data)
        with args.binding.open('x') as output:
            json.dump(metadata, output, sort_keys=True)
    else:
        check_binding(doc, args.source.read_bytes(), args.image_id, load(args.binding, 1024))
    print(json.dumps({'packages': len(doc['packages']), 'files': len(doc.get('files', [])),
                      'relationships': len(doc['relationships']), 'image_id': args.image_id}))


if __name__ == '__main__':
    main()
