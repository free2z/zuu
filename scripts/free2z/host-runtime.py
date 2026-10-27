#!/usr/bin/env python3
"""Prepare a host runtime; no deployment or host-service commands are exposed."""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import urllib.parse

from host_runtime import manifest, package, provenance, tools

ROOT = Path(__file__).resolve().parents[2]


def read_json(path):
    return json.loads(provenance.read(path, 16 * 1024 ** 2))


def file_digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return 'sha256:' + value.hexdigest()


def identity():
    commit = os.environ['GITHUB_SHA']
    if (os.environ.get('GITHUB_REPOSITORY') != 'free2z/zuu'
            or os.environ.get('GITHUB_REF') != 'refs/heads/main'
            or os.environ.get('GITHUB_REF_PROTECTED') != 'true'
            or os.environ.get('GITHUB_EVENT_NAME') != 'workflow_dispatch'
            or not re.fullmatch(r'[0-9a-f]{40}', commit)
            or subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip() != commit):
        raise ValueError('host producer requires the exact protected-main dispatch checkout')
    return commit


def fetch(args):
    commit = identity()
    args.work.mkdir(mode=0o700)
    args.output.mkdir(mode=0o700)
    lock = tools.install(ROOT, args.work / 'tools')
    web = provenance.verify(ROOT, args.work / 'tools/gh', args.web_tag, commit,
                            args.output / 'web-release')
    names = subprocess.check_output(['git', 'ls-files', '-z', '--', 'rs/zcash-payment-hooks',
                                     'rust-toolchain.toml', 'LICENSE', 'build/free2z/host-tools.json',
                                     'scripts/free2z/host_runtime', 'scripts/free2z/host-runtime.py',
                                     'scripts/free2z/host-runtime-qualify.py', 'scripts/free2z/host-rust-build.sh'],
                                    cwd=ROOT).decode().split('\0')
    files = {}
    for name in filter(None, names):
        path = ROOT / name
        if path.is_symlink() or not path.is_file():
            raise ValueError('build source contains non-regular tracked input')
        files[name] = file_digest(path)
    inputs = dict(source=web['source'], backend=web['images']['backend'],
                  web_release_id=file_digest(args.output / 'web-release/release.json'),
                  source_files=files, tools=lock)
    (args.work / 'inputs.json').write_bytes(package.json_bytes(inputs))


def assemble(args):
    commit = identity()
    if any(name in os.environ for name in ('GH_TOKEN', 'GITHUB_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN')):
        raise ValueError('build step must not receive release or OIDC credentials')
    inputs = read_json(args.work / 'inputs.json')
    if inputs['source'] != dict(repository='free2z/zuu', commit=commit):
        raise ValueError('verified input does not match workflow checkout')
    if file_digest(args.output / 'web-release/release.json') != inputs['web_release_id']:
        raise ValueError('verified website evidence changed')
    for name, expected in inputs['source_files'].items():
        if file_digest(ROOT / name) != expected:
            raise ValueError('build source changed after verification')
    if shutil.disk_usage(args.work).free < 14 * 1024 ** 3:
        raise ValueError('host build requires at least 14 GiB free scratch space')
    docker_config = args.work / 'docker-config'
    docker_config.mkdir(mode=0o700)
    environment = {'PATH': os.environ['PATH'], 'HOME': str(args.work), 'DOCKER_CONFIG': str(docker_config)}
    # CI trust selection configures these public certificate paths before any
    # clients. Credentials and unrelated job environment are not inherited.
    for name in ('SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE'):
        if name in os.environ:
            environment[name] = os.environ[name]

    def docker(*command, timeout=180, capture=False):
        result = subprocess.run(['docker', *map(str, command)], check=True, timeout=timeout,
                                env=environment, stdout=subprocess.PIPE if capture else None)
        return result.stdout if capture else None

    image = inputs['backend']['repository'] + '@' + inputs['backend']['digest']
    docker('pull', '--platform=linux/amd64', image)
    metadata = json.loads(docker('image', 'inspect', image, capture=True))[0]
    labels = metadata['Config'].get('Labels') or {}
    if (metadata['Os'] != 'linux' or metadata['Architecture'] != 'amd64'
            or labels.get('org.opencontainers.image.revision') != commit
            or labels.get('org.opencontainers.image.source') != 'https://github.com/free2z/zuu'):
        raise ValueError('backend image platform/source mismatch')
    container = docker('create', '--platform=linux/amd64', image, capture=True).decode().strip()
    try:
        docker('export', '--output', args.work / 'backend.tar', container, timeout=300)
    finally:
        docker('rm', '--volumes', container)
    rust = args.work / 'rust'
    rust.mkdir(mode=0o755)
    docker('run', '--rm', '--platform=linux/amd64', '--read-only', '--cap-drop=ALL',
           '--security-opt=no-new-privileges', '--pids-limit=512', '--cpus=2', '--memory=6g',
           '--user=' + str(os.getuid()) + ':' + str(os.getgid()),
           '--tmpfs=/tmp:rw,nosuid,size=4g',
           '--mount', f'type=bind,source={ROOT},target=/src,readonly',
           '--mount', f'type=bind,source={args.work / "tools"},target=/tools,readonly',
           '--mount', f'type=bind,source={rust},target=/work',
           '--entrypoint=/bin/sh', image, '/src/scripts/free2z/host-rust-build.sh', timeout=3600)
    payload = args.work / 'payload'
    package.prepare(args.work / 'backend.tar', payload, rust / 'zcash-paymentd',
                    args.work / 'tools/patchelf', inputs, rust / 'licenses')
    qualification = inputs['tools']['qualification_image']
    docker('pull', '--platform=linux/amd64', qualification)
    reports = args.work / 'reports'
    reports.mkdir(mode=0o777)
    reports.chmod(0o777)
    results = []
    # Different depths catch accidental assumptions about cwd and path length.
    for index, prefix in enumerate(('/opt/qualification-a', '/srv/relocated/deeper/runtime-b')):
        name = str(index) + '.json'
        docker('run', '--rm', '--platform=linux/amd64', '--network=none', '--read-only',
               '--add-host=host-qualification.invalid:192.0.2.1',
               '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128',
               '--cpus=2', '--memory=2g', '--user=65532:65532', '--workdir=/tmp',
               '--tmpfs=/tmp:rw,noexec,nosuid,size=128m',
               '--mount', f'type=bind,source={payload},target={prefix},readonly',
               '--mount', f'type=bind,source={ROOT / "scripts/free2z/host-runtime-qualify.py"},target=/qualification.py,readonly',
               '--mount', f'type=bind,source={reports},target=/reports',
               '--entrypoint=/usr/bin/env', qualification, '-i', prefix + '/runtime/bin/python',
               '-I', '/qualification.py', '--payload', prefix, '--report', '/reports/' + name,
               timeout=300)
        result = read_json(reports / name)
        if result['prefix'] != prefix:
            raise ValueError('qualification report has wrong extraction prefix')
        results.append(result)
    if results[0]['python'] != results[1]['python']:
        raise ValueError('interpreter identity changed across relocation')
    evidence_path = payload / 'runtime/derivation.json'
    evidence = read_json(evidence_path)
    evidence['qualification'] = dict(image=qualification, runs=results)
    evidence_path.chmod(0o644)
    evidence_path.write_bytes(package.json_bytes(evidence))
    evidence_path.chmod(0o444)
    archive = args.output / 'host-runtime.tar'
    inventory = package.archive(payload, archive)
    inventory_path = args.output / 'host-files.json'
    inventory_path.write_bytes(package.json_bytes(inventory))
    value = dict(schema_version=2, protocol=manifest.PROTOCOL, source=inputs['source'],
                 build=dict(workflow=manifest.WORKFLOW, run_id=os.environ['GITHUB_RUN_ID'],
                            run_attempt=int(os.environ['GITHUB_RUN_ATTEMPT'])),
                 web_release=dict(release_id=inputs['web_release_id'], backend_digest=inputs['backend']['digest']),
                 platform=package.PLATFORM, runtime=dict(python=results[0]['python'], evidence='runtime/derivation.json'),
                 archive=dict(name='host-runtime.tar', sha256=file_digest(archive), size=archive.stat().st_size,
                              inventory_sha256=file_digest(inventory_path)))
    (args.output / 'host-release.json').write_bytes(package.json_bytes(manifest.check(value)))


def check(args):
    """Publisher check: data only, no imports or execution from the payload."""
    commit = identity()
    value = manifest.check(read_json(args.output / 'host-release.json'))
    if (value['source']['commit'] != commit or value['build']['run_id'] != os.environ['GITHUB_RUN_ID']
            or value['build']['run_attempt'] != int(os.environ['GITHUB_RUN_ATTEMPT'])):
        raise ValueError('host artifact does not match publishing invocation')
    archive = args.output / 'host-runtime.tar'
    if (archive.is_symlink() or not archive.is_file() or archive.stat().st_size != value['archive']['size']
            or file_digest(archive) != value['archive']['sha256']
            or file_digest(args.output / 'host-files.json') != value['archive']['inventory_sha256']
            or file_digest(args.output / 'web-release/release.json') != value['web_release']['release_id']):
        raise ValueError('host artifact digest mismatch')


def publish(args):
    """Upload data using the checked-out publisher, without installing a client."""
    check(args)
    commit = identity()
    tag = f"free2z-host-{commit}-{os.environ['GITHUB_RUN_ID']}-{os.environ['GITHUB_RUN_ATTEMPT']}"
    assets = {name: args.output / name for name in ('host-release.json', 'host-files.json',
              'host-runtime.tar', 'host-release.json.intoto.jsonl', 'host-runtime.tar.intoto.jsonl')}
    for name in ('release.json', 'static-assets.json', 'release.intoto.jsonl',
                 'backend.manifest.json', 'backend.intoto.jsonl', 'web.manifest.json',
                 'web.intoto.jsonl', 'static.manifest.json', 'static.intoto.jsonl'):
        assets['website-' + name] = args.output / 'web-release' / name
    for name, path in assets.items():
        maximum = 2 * 1024 ** 3 if name == 'host-runtime.tar' else 16 * 1024 ** 2
        if path.is_symlink() or not path.is_file() or path.stat().st_size > maximum:
            raise ValueError('missing or oversized release asset')
    headers = {'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
               'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10',
               'User-Agent': 'free2z-host-preparation'}
    connection = http.client.HTTPSConnection('api.github.com', timeout=180)
    body = package.json_bytes(dict(tag_name=tag, target_commitish=commit,
                                  name='Free2Z host preparation ' + commit, prerelease=True,
                                  make_latest='false', body='Signed native application preparation. Activation requires independent deployment verification and host qualification.'))
    try:
        connection.request('POST', '/repos/free2z/zuu/releases', body,
                           {**headers, 'Content-Type': 'application/json'})
        response = connection.getresponse()
        data = response.read(65537)
        if response.status != 201 or len(data) > 65536:
            raise ValueError('GitHub rejected preparation release creation')
        identifier = json.loads(data)['id']
        if type(identifier) is not int or identifier <= 0:
            raise ValueError('invalid created release identity')
    finally:
        connection.close()
    for name, path in assets.items():
        connection = http.client.HTTPSConnection('uploads.github.com', timeout=180)
        try:
            connection.putrequest('POST', f'/repos/free2z/zuu/releases/{identifier}/assets?name=' + urllib.parse.quote(name))
            for key, value in {**headers, 'Content-Type': 'application/octet-stream',
                               'Content-Length': str(path.stat().st_size)}.items():
                connection.putheader(key, value)
            connection.endheaders()
            with path.open('rb') as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    connection.send(block)
            response = connection.getresponse()
            data = response.read(65537)
            if response.status != 201 or len(data) > 65536:
                raise ValueError('GitHub rejected preparation release asset: ' + name)
        finally:
            connection.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('fetch', 'assemble', 'check', 'publish'))
    parser.add_argument('--work', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--web-tag')
    args = parser.parse_args()
    args.output = args.output.resolve()
    if args.work is not None:
        args.work = args.work.resolve()
    if args.command in ('fetch', 'assemble') and args.work is None:
        parser.error('--work is required for build commands')
    if args.command == 'fetch' and not args.web_tag:
        parser.error('--web-tag is required for fetching verified inputs')
    globals()[args.command](args)
