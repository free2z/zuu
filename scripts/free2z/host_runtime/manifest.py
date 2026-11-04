"""Data-only host preparation protocol; importing this module executes no payload."""
import re

from .package import PLATFORM

WORKFLOW = '.github/workflows/free2z-host-release.yml'
PROTOCOL = 'free2z-host-preparation-v2'
SHA = re.compile(r'[0-9a-f]{40}\Z')
DIGEST = re.compile(r'sha256:[0-9a-f]{64}\Z')


def exact(value, names):
    if not isinstance(value, dict) or set(value) != set(names):
        raise ValueError('unexpected manifest fields')


def check(value):
    exact(value, ('schema_version', 'protocol', 'source', 'build', 'web_release',
                  'platform', 'runtime', 'archive'))
    if type(value['schema_version']) is not int or value['schema_version'] != 2 or value['protocol'] != PROTOCOL:
        raise ValueError('unsupported host protocol')
    exact(value['source'], ('repository', 'commit'))
    if value['source']['repository'] != 'free2z/zuu' or not SHA.fullmatch(value['source']['commit']):
        raise ValueError('invalid public source')
    exact(value['build'], ('workflow', 'run_id', 'run_attempt'))
    build = value['build']
    if (build['workflow'] != WORKFLOW or not isinstance(build['run_id'], str)
            or not re.fullmatch(r'[1-9][0-9]{0,19}', build['run_id'])
            or type(build['run_attempt']) is not int or not 1 <= build['run_attempt'] <= 10000):
        raise ValueError('invalid producing workflow invocation')
    exact(value['web_release'], ('release_id', 'backend_digest'))
    for digest in value['web_release'].values():
        if not isinstance(digest, str) or not DIGEST.fullmatch(digest):
            raise ValueError('invalid web release binding')
    if value['platform'] != PLATFORM:
        raise ValueError('unsupported host platform')
    exact(value['runtime'], ('python', 'evidence'))
    exact(value['runtime']['python'], ('implementation', 'version', 'soabi'))
    python = value['runtime']['python']
    if (python['implementation'] != 'cpython' or not isinstance(python['version'], str)
            or not re.fullmatch(r'3\.[0-9]+\.[0-9]+', python['version'])
            or python['soabi'] != 'cpython-' + ''.join(python['version'].split('.')[:2]) + '-x86_64-linux-gnu'
            or value['runtime']['evidence'] != 'runtime/derivation.json'):
        raise ValueError('invalid bundled interpreter identity')
    exact(value['archive'], ('name', 'sha256', 'size', 'inventory_sha256'))
    archive = value['archive']
    if (archive['name'] != 'host-runtime.tar' or type(archive['size']) is not int
            or not 0 < archive['size'] <= 2 * 1024 ** 3):
        raise ValueError('invalid runtime archive')
    for field in ('sha256', 'inventory_sha256'):
        if not isinstance(archive[field], str) or not DIGEST.fullmatch(archive[field]):
            raise ValueError('invalid runtime archive digest')
    return value
