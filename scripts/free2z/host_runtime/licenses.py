"""Retain crate license evidence from locked archives and reviewed supplements."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import tarfile
import tomllib

REGISTRY = 'registry+https://github.com/rust-lang/crates.io-index'
PREFIXES = ('license', 'licence', 'copying', 'copyright', 'notice')
MAX_FILE = 4 * 1024 ** 2


def sha(data):
    return hashlib.sha256(data).hexdigest()


def relative(name):
    if (not isinstance(name, str) or not name.isascii() or not name
            or PurePosixPath(name).as_posix() != name or name.startswith('/')
            or '..' in name.split('/') or any(ord(c) < 32 for c in name)):
        raise ValueError('invalid license path')
    return name


def load_supplements(directory, locked):
    value = json.loads((directory / 'manifest.json').read_text())
    if set(value) != {'schema_version', 'packages'} or value['schema_version'] != 1:
        raise ValueError('unknown license supplement schema')
    result = {}
    for row in value['packages']:
        key = (row['name'], row['version'], REGISTRY)
        if key in result or row['checksum'] != locked.get(key):
            raise ValueError('license supplement differs from locked crate checksum')
        if not re.fullmatch('[0-9a-f]{40}', row['commit']):
            raise ValueError('license supplement requires immutable upstream commit')
        repo = row['repository'].removeprefix('https://github.com/')
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo):
            raise ValueError('unexpected license supplement repository')
        prefix = f'https://raw.githubusercontent.com/{repo}/{row["commit"]}/'
        if not row['files']:
            raise ValueError('empty license supplement')
        seen = set()
        for file in row['files']:
            name = relative(file['path'])
            if name in seen or not name.startswith(row['name'] + '-' + row['version'] + '/'):
                raise ValueError('license supplement path does not identify its crate')
            seen.add(name)
            path = directory / name
            if (path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_FILE
                    or path.resolve() != directory.resolve() / name
                    or sha(path.read_bytes()) != file['sha256']):
                raise ValueError('license supplement text digest mismatch')
            if not file['upstream_url'].startswith(prefix):
                raise ValueError('license supplement URL differs from upstream identity')
            relative(file['upstream_url'][len(prefix):])
        result[key] = row
    return result


def archive_licenses(path, name, checksum):
    if (path.is_symlink() or not path.is_file() or path.stat().st_size > 512 * 1024 ** 2
            or sha(path.read_bytes()) != checksum):
        raise ValueError('crate archive differs from Cargo.lock checksum')
    selected, members = {}, {}
    prefix = name + '/'
    with tarfile.open(path) as archive:
        for index, member in enumerate(archive):
            if index >= 50000 or member.name in members or not member.name.startswith(prefix):
                raise ValueError('invalid crate archive inventory')
            member_name = relative(member.name[len(prefix):])
            members[member.name] = member
            if member_name in ('Cargo.toml', '.cargo_vcs_info.json') or any(
                    part.lower().startswith((*PREFIXES, 'authors')) for part in member_name.split('/')):
                if not member.isfile() or member.size > MAX_FILE:
                    raise ValueError('invalid crate license file')
                with archive.extractfile(member) as stream:
                    selected[member_name] = stream.read()
        metadata = tomllib.loads(selected.pop('Cargo.toml').decode())['package']
        declared = metadata.get('license-file')
        if declared and declared not in selected:
            member = members.get(prefix + relative(declared))
            if member is None or not member.isfile() or member.size > MAX_FILE:
                raise ValueError('missing declared crate license file')
            with archive.extractfile(member) as stream:
                selected[declared] = stream.read()
    vcs = json.loads(selected.pop('.cargo_vcs_info.json')) if '.cargo_vcs_info.json' in selected else None
    coverage = bool(declared) or any(any(part.lower().startswith(PREFIXES)
                                        for part in name.split('/')) for name in selected)
    return metadata, vcs, selected, coverage


def collect(repository, metadata, cargo_home, destination):
    locked = {(p['name'], p['version'], p.get('source')): p.get('checksum')
              for p in tomllib.loads((repository / 'rs/zcash-payment-hooks/Cargo.lock').read_text())['package']}
    supplements_dir = repository / 'build/free2z/host-licenses'
    supplements = load_supplements(supplements_dir, locked)
    destination.mkdir()
    packages, seen = [], set()
    for package in metadata['packages']:
        key = (package['name'], package['version'], package['source'])
        name = relative(package['name'] + '-' + package['version'])
        if '/' in name or key in seen or key not in locked:
            raise ValueError('crate metadata differs from locked package inventory')
        seen.add(key)
        row = supplements.get(key)
        if package['source'] == REGISTRY:
            archives = list((cargo_home / 'registry/cache').glob('*/' + name + '.crate'))
            if len(archives) != 1:
                raise ValueError('missing or ambiguous locked crate archive')
            manifest, vcs, files, covered = archive_licenses(archives[0], name, locked[key])
            if (manifest['name'], manifest['version'], manifest.get('license')) != (
                    package['name'], package['version'], package.get('license')):
                raise ValueError('crate manifest differs from Cargo metadata')
        elif package['source'] is None:
            source = Path(package['manifest_path']).parent
            if source.resolve() != repository.resolve() / 'rs/zcash-payment-hooks':
                raise ValueError('unexpected first-party crate path')
            files = {path.name: path.read_bytes() for path in source.iterdir()
                     if path.is_file() and not path.is_symlink() and path.name.lower().startswith(PREFIXES)}
            covered, vcs = bool(files), None
        else:
            raise ValueError('unsupported crate source for license collection')
        target = destination / name
        target.mkdir()
        inventory = {}

        def retain(path, data):
            path = relative(path)
            output = target / path
            output.parent.mkdir(parents=True, exist_ok=True)
            with output.open('xb') as stream:
                stream.write(data)
            inventory[path] = 'sha256:' + sha(data)

        for path, data in sorted(files.items()):
            retain(path, data)
        if row:
            if row['license'] != package.get('license'):
                raise ValueError('license supplement SPDX declaration differs')
            basis = row['basis']
            if basis['kind'] == 'crate-vcs-info':
                if not vcs or vcs.get('git', {}).get('sha1') != row['commit'] or basis['commit'] != row['commit']:
                    raise ValueError('license supplement differs from crate VCS identity')
            elif basis['kind'] == 'repository-manifest-version-match':
                if vcs is not None or not package['name'].startswith('winapi-'):
                    raise ValueError('unexpected inferred license provenance')
                evidence = next((file for file in row['files']
                                 if file['path'] == basis['manifest_path']), None)
                if (evidence is None or evidence['sha256'] != basis['manifest_sha256']
                        or evidence['upstream_url'] != basis['manifest_url']):
                    raise ValueError('missing upstream manifest evidence')
                upstream = tomllib.loads((supplements_dir / evidence['path']).read_text())['package']
                if (upstream['name'], upstream['version'], upstream.get('license'), upstream.get('repository')) != (
                        row['name'], row['version'], row['license'], row['repository']):
                    raise ValueError('upstream manifest does not establish package identity')
            else:
                raise ValueError('unknown license supplement provenance')
            for file in row['files']:
                retain('upstream/' + PurePosixPath(file['path']).name,
                       (supplements_dir / file['path']).read_bytes())
            retain('upstream/provenance.json', (json.dumps(row, sort_keys=True) + '\n').encode())
            covered = True
        if not covered:
            raise ValueError('crate has no reviewed license text: ' + name)
        packages.append(dict(name=package['name'], version=package['version'], source=package['source'],
                             license=package.get('license'), files=inventory))
    (destination / 'packages.json').write_text(json.dumps(packages, sort_keys=True) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', required=True, type=Path)
    parser.add_argument('--metadata', required=True, type=Path)
    parser.add_argument('--cargo-home', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    collect(args.repository, json.loads(args.metadata.read_text()), args.cargo_home, args.output)
