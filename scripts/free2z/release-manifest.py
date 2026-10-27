#!/usr/bin/env python3
"""Create and validate the public website release contract consumed by deployment."""
from pathlib import Path
import argparse
import hashlib
import json
import re

REPOSITORIES = {kind: f'ghcr.io/free2z/free2z-{name}' for kind, name in [('backend', 'backend'), ('web', 'web'), ('static', 'static')]}
WORKFLOW = '.github/workflows/free2z-web-release.yml'
DIGEST = re.compile(r'sha256:[0-9a-f]{64}')
TASK_NAME = re.compile(r'[A-Za-z_][A-Za-z0-9_.:-]{0,255}', re.ASCII)
MAX_MANIFEST_BYTES = 64 * 1024


def sha256(data: bytes) -> str:
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def inventory(root: Path) -> dict[str, str]:
    entries = {}
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise ValueError('static asset symlink refused')
        if path.is_file():
            entries[path.relative_to(root).as_posix()] = sha256(path.read_bytes())
    if not entries or not any(name.startswith('_app/immutable/') for name in entries):
        raise ValueError('missing immutable browser assets')
    return entries


def validate_task_registry(value: dict) -> dict:
    if not isinstance(value, dict) or set(value) != {'schema_version', 'registered', 'scheduled'} or type(value['schema_version']) is not int or value['schema_version'] != 1:
        raise ValueError('unknown task registry schema')
    for key in ('registered', 'scheduled'):
        names = value[key]
        if not isinstance(names, list) or len(names) > 1024 or any(not isinstance(name, str) or not TASK_NAME.fullmatch(name) for name in names):
            raise ValueError('invalid task registry names')
        if names != sorted(set(names)):
            raise ValueError('task registry names must be sorted and unique')
    if not value['registered'] or not set(value['scheduled']).issubset(value['registered']):
        raise ValueError('scheduled tasks must have a nonempty registered inventory')
    return value


def read_task_registry(path: Path, commit: str) -> dict:
    if path.stat().st_size > MAX_MANIFEST_BYTES:
        raise ValueError('task registry artifact is too large')
    value = json.loads(path.read_text())
    if not isinstance(value, dict) or set(value) != {'source', 'task_registry'} or value['source'] != {'repository': 'free2z/zuu', 'commit': commit}:
        raise ValueError('task registry does not match release source')
    return validate_task_registry(value['task_registry'])


def validate(value: dict) -> dict:
    if set(value) != {'schema_version', 'source', 'build', 'images', 'static_assets', 'task_registry'} or type(value['schema_version']) is not int or value['schema_version'] != 1:
        raise ValueError('unknown release schema')
    source = value['source']
    if set(source) != {'repository', 'commit'} or source['repository'] != 'free2z/zuu' or not re.fullmatch('[0-9a-f]{40}', source['commit']):
        raise ValueError('unexpected source')
    build = value['build']
    if set(build) != {'workflow', 'run_id', 'run_attempt'} or build['workflow'] != WORKFLOW or not isinstance(build['run_id'], str) or not re.fullmatch('[1-9][0-9]*', build['run_id']) or type(build['run_attempt']) is not int or build['run_attempt'] < 1:
        raise ValueError('unexpected build identity')
    if set(value['images']) != set(REPOSITORIES):
        raise ValueError('incomplete image set')
    for kind, repository in REPOSITORIES.items():
        image = value['images'][kind]
        if set(image) != {'repository', 'digest'} or image['repository'] != repository or not DIGEST.fullmatch(image['digest']):
            raise ValueError('unexpected image reference')
    assets = value['static_assets']
    if set(assets) != {'path', 'inventory', 'sha256'} or assets['path'] != '/app/build/client' or assets['inventory'] != 'static-assets.json' or not DIGEST.fullmatch(assets['sha256']):
        raise ValueError('unexpected static inventory')
    validate_task_registry(value['task_registry'])
    if len((json.dumps(value, sort_keys=True, indent=2) + '\n').encode()) > MAX_MANIFEST_BYTES:
        raise ValueError('release manifest exceeds 64KiB')
    return value


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, sort_keys=True, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    listing = sub.add_parser('inventory')
    listing.add_argument('root', type=Path)
    listing.add_argument('output', type=Path)
    create = sub.add_parser('create')
    create.add_argument('--commit', required=True)
    create.add_argument('--run-id', required=True)
    create.add_argument('--run-attempt', type=int, required=True)
    create.add_argument('--digests', type=Path, required=True)
    create.add_argument('--inventory', type=Path, required=True)
    create.add_argument('--task-registry', type=Path, required=True)
    create.add_argument('--output', type=Path, required=True)
    check = sub.add_parser('check')
    check.add_argument('manifest', type=Path)
    args = parser.parse_args()
    if args.command == 'inventory':
        write_json(args.output, inventory(args.root))
    elif args.command == 'check':
        if args.manifest.stat().st_size > MAX_MANIFEST_BYTES:
            raise ValueError('release manifest exceeds 64KiB')
        validate(json.loads(args.manifest.read_text()))
        print(sha256(args.manifest.read_bytes()))
    else:
        digests = json.loads(args.digests.read_text())
        value = {'schema_version': 1, 'task_registry': read_task_registry(args.task_registry, args.commit), 'source': {'repository': 'free2z/zuu', 'commit': args.commit}, 'build': {'workflow': WORKFLOW, 'run_id': args.run_id, 'run_attempt': args.run_attempt}, 'images': {kind: {'repository': repo, 'digest': digests[kind]} for kind, repo in REPOSITORIES.items()}, 'static_assets': {'path': '/app/build/client', 'inventory': 'static-assets.json', 'sha256': sha256(args.inventory.read_bytes())}}
        write_json(args.output, validate(value))
