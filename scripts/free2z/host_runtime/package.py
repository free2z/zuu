"""Derive a relocatable native runtime from an already verified image export.

This module does not establish image provenance. Its caller must verify the
signed website release and export its exact backend digest before calling it.
"""
import hashlib
import json
import os
from pathlib import PurePosixPath
import re
import subprocess
import tarfile

from .elf import ELF
from .image import Image, MAX_FILE, canonical
from . import relocation

SYSTEM_LIBRARIES = ['ld-linux-x86-64.so.2', 'libc.so.6', 'libdl.so.2',
                    'libm.so.6', 'libpthread.so.0', 'libresolv.so.2', 'librt.so.1']
PLATFORM = dict(os='linux', distribution='debian', distribution_version='12',
                architecture='x86_64', libc=dict(family='glibc', version='2.36'),
                loader='/lib64/ld-linux-x86-64.so.2', system_libraries=SYSTEM_LIBRARIES)
DEFAULT_LIBDIRS = ('usr/local/lib', 'lib/x86_64-linux-gnu', 'usr/lib/x86_64-linux-gnu',
                   'lib64', 'usr/lib64', 'lib', 'usr/lib')


def digest(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


def safe_name(name):
    if (not isinstance(name, str) or not name.isascii() or name != canonical(name)
            or name.startswith('/') or not name or len(name) > 255
            or any(ord(c) < 32 or ord(c) == 127 for c in name)):
        raise ValueError('invalid payload path')
    if not (name.startswith(('runtime/', 'py/')) or name == 'bin/zcash-paymentd'):
        raise ValueError('path outside host runtime')
    if name.startswith('py/env/'):
        raise ValueError('virtual environments are not relocatable payloads')


def native(data):
    return ELF(data) if data.startswith(b'\x7fELF') else None


class Package:
    def __init__(self, image, destination, patchelf):
        if destination.exists():
            raise ValueError('payload destination already exists')
        destination.mkdir(mode=0o755, parents=True)
        self.image, self.root, self.patchelf = image, destination, patchelf
        self.sources, self.elfs, self.edges = {}, {}, {}
        self.library_sources = {}
        self.total = 0

    def add(self, name, data, source):
        safe_name(name)
        if name in self.sources or len(self.sources) >= 50000:
            raise ValueError('duplicate or excessive payload entries')
        if len(data) > MAX_FILE or self.total + len(data) > 4 * 1024 ** 3:
            raise ValueError('runtime size limit exceeded')
        self.total += len(data)
        elf = native(data)
        if elf:
            elf.compatible()
            self.elfs[name] = elf
        target = self.root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        self.sources[name] = dict(source=source, sha256=digest(data))

    def copy(self, source, target):
        original, data = self.image.read(source)
        self.add(target, data, 'image:/' + original)

    def resolve_dependency(self, source, elf, dependency):
        origin = str(PurePosixPath(source).parent)
        search = []
        for path in elf.runpath or elf.rpath:
            path = path.replace('${ORIGIN}', '/' + origin).replace('$ORIGIN', '/' + origin)
            if '$' in path or not path.startswith('/'):
                raise ValueError('unsupported or relative image library search path')
            search.append(canonical(path))
        for directory in [*search, *DEFAULT_LIBDIRS]:
            try:
                return self.image.read(directory + '/' + dependency)
            except FileNotFoundError:
                pass
        raise ValueError('unresolved image dependency: ' + source + ': ' + dependency)

    def close_native_dependencies(self):
        pending, complete = list(self.elfs), set()
        while pending:
            name = pending.pop()
            if name in complete:
                continue
            complete.add(name)
            elf = self.elfs[name]
            source = self.sources[name]['source']
            # Rust is compiled in this same image; it has no private RPATH.
            source = source.removeprefix('image:/') if source.startswith('image:/') else 'bin/zcash-paymentd'
            self.edges[name] = {}
            for dependency in elf.needed:
                if dependency in SYSTEM_LIBRARIES:
                    self.edges[name][dependency] = 'host:' + dependency
                    continue
                original, data = self.resolve_dependency(source, elf, dependency)
                signature = digest(data)
                if dependency in self.library_sources and self.library_sources[dependency] != signature:
                    raise ValueError('conflicting native dependency name: ' + dependency)
                self.library_sources[dependency] = signature
                target = 'runtime/lib/' + dependency
                self.edges[name][dependency] = target
                if target not in self.sources:
                    self.add(target, data, 'image:/' + original)
                    if target not in self.elfs:
                        raise ValueError('shared library is not ELF')
                    pending.append(target)
                elif self.sources[target]['sha256'] != signature:
                    raise ValueError('conflicting runtime library destination')
        for name, elf in self.elfs.items():
            target = self.root / name
            relative = os.path.relpath(self.root / 'runtime/lib', target.parent)
            runpath = '$ORIGIN' if relative == '.' else '$ORIGIN/' + relative
            # Every object receives its own RUNPATH: the executable's RUNPATH
            # is not inherited by extensions or their transitive dependencies.
            subprocess.run([str(self.patchelf), '--set-rpath', runpath, str(target)],
                           check=True, timeout=30, env={'PATH': '/usr/bin:/bin'})
            changed = ELF(target.read_bytes())
            changed.compatible()
            if changed.needed != elf.needed or changed.runpath != [runpath] or changed.rpath:
                raise ValueError('ELF patch changed dependencies or failed to set RUNPATH')
            self.sources[name]['patched_sha256'] = digest(target.read_bytes())
            self.sources[name]['runpath'] = runpath

    def finish(self, inputs):
        candidates = [name for name in self.sources
                      if re.fullmatch(r'runtime/lib/python3\.[0-9]+/site-packages/psycopg/pq/misc.py', name)]
        if len(candidates) != 1:
            raise ValueError('expected one locked psycopg resolver')
        name = candidates[0]
        target = self.root / name
        target.write_bytes(relocation.psycopg(target.read_bytes()))
        self.sources[name]['patched_sha256'] = digest(target.read_bytes())
        self.sources[name]['relocation_patch'] = 'psycopg-3.3.6-bundled-libpq-v1'
        self.close_native_dependencies()
        evidence = dict(schema_version=1, inputs=inputs, files=self.sources,
                        native_dependencies=self.edges, host_platform=PLATFORM)
        path = self.root / 'runtime/derivation.json'
        path.write_bytes(json_bytes(evidence))
        for target in self.root.rglob('*'):
            if target.is_file():
                name = target.relative_to(self.root).as_posix()
                target.chmod(0o555 if name in self.elfs else 0o444)
        return evidence


def prepare(image_path, destination, daemon, patchelf, inputs, rust_licenses):
    image = Image(image_path)
    try:
        os_release = dict(line.split('=', 1) for line in image.read('etc/os-release')[1].decode().splitlines()
                          if '=' in line and not line.startswith('#'))
        if os_release.get('ID', '').strip('"') != 'debian' or os_release.get('VERSION_ID', '').strip('"') != '12':
            raise ValueError('backend image is not Debian 12')
        interpreters = [name for name in image.files('usr/local/bin')
                        if re.fullmatch(r'usr/local/bin/python3\.\d+', name)]
        if len(interpreters) != 1:
            raise ValueError('expected exactly one bundled CPython interpreter')
        python = interpreters[0].rsplit('/', 1)[1]
        package = Package(image, destination, patchelf)
        package.copy(interpreters[0], 'runtime/bin/python')
        # psycopg's ctypes loader is not represented by an ELF DT_NEEDED edge.
        package.copy('usr/lib/x86_64-linux-gnu/libpq.so.5', 'runtime/lib/libpq.so.5')
        for source in image.files('usr/local/lib/' + python):
            # Bytecode caches and developer entrypoints contain build paths.
            if ('__pycache__' not in PurePosixPath(source).parts
                    and not source.endswith(('.pyc', '.pyo', '.o', '.a'))):
                package.copy(source, 'runtime/lib/' + source.removeprefix('usr/local/lib/'))
        for source in image.files('py'):
            package.copy(source, source)
        for required in ('py/dj/free2z/manage.py', 'py/zcashrpc/paymentd_mode.py'):
            if required not in package.sources:
                raise ValueError('incomplete backend application tree')
        # Retain system copyright/license texts, Python's LICENSE.txt and wheel
        # dist-info license metadata. No compiler or package manager is copied.
        for source in image.files('usr/share/doc'):
            package.copy(source, 'runtime/share/licenses/debian/' + source.removeprefix('usr/share/doc/'))
        package.copy('etc/ssl/certs/ca-certificates.crt', 'runtime/share/ca-certificates.crt')
        for source in image.files('opt/tiktoken-cache'):
            package.copy(source, 'runtime/share/tiktoken-cache/' + source.removeprefix('opt/tiktoken-cache/'))
        for source in sorted(rust_licenses.rglob('*')):
            if source.is_symlink():
                raise ValueError('symlink in Rust license inventory')
            if source.is_file():
                package.add('runtime/share/licenses/rust/' + source.relative_to(rust_licenses).as_posix(),
                            source.read_bytes(), 'cargo-license:' + source.relative_to(rust_licenses).as_posix())
        if not (rust_licenses / 'packages.json').is_file():
            raise ValueError('Rust dependency license inventory missing')
        package.add('bin/zcash-paymentd', daemon.read_bytes(), 'cargo:rs/zcash-payment-hooks')
        if 'bin/zcash-paymentd' not in package.elfs:
            raise ValueError('daemon is not a native ELF executable')
        return package.finish(inputs)
    finally:
        image.close()


def archive(root, output):
    inventory, expanded = {}, 0
    with tarfile.open(output, 'x', format=tarfile.USTAR_FORMAT) as archive_file:
        for path in sorted(root.rglob('*')):
            if path.is_symlink():
                raise ValueError('payload contains a symlink')
            if path.is_dir():
                continue
            name = path.relative_to(root).as_posix()
            safe_name(name)
            mode = path.stat().st_mode & 0o7777
            size = path.stat().st_size
            if not path.is_file() or mode not in (0o444, 0o555) or size > MAX_FILE:
                raise ValueError('invalid payload file or mode')
            expanded += size
            if len(inventory) >= 50000 or expanded > 4 * 1024 ** 3:
                raise ValueError('payload inventory too large')
            data = path.read_bytes()
            inventory[name] = dict(sha256=digest(data), size=size, mode=f'{mode:04o}')
            entry = tarfile.TarInfo(name)
            entry.mode, entry.size = mode, size
            with path.open('rb') as stream:
                archive_file.addfile(entry, stream)
    if output.stat().st_size > 2 * 1024 ** 3 or len(json_bytes(inventory)) > 8 * 1024 ** 2:
        raise ValueError('archive or inventory size limit exceeded')
    return inventory
