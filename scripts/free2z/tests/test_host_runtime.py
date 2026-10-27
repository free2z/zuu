"""Adversarial packaging tests; no payload execution, network, or third-party modules."""
import copy
import hashlib
import io
import json
from pathlib import Path
import struct
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from host_runtime.elf import ELF
from host_runtime.image import Image
from host_runtime.manifest import check, PROTOCOL, WORKFLOW
from host_runtime.package import PLATFORM, Package, archive, digest


def elf(needed=(), runpath=None, rpath=None, glibc='2.36', interpreter=None):
    strings = bytearray(b'\0')
    dynamic = []
    for tag, values in ((1, needed), (29, [runpath] if runpath is not None else []),
                        (15, [rpath] if rpath is not None else [])):
        for value in values:
            dynamic.append((tag, len(strings)))
            strings.extend(value.encode() + b'\0')
    strings.extend(('GLIBC_' + glibc).encode() + b'\0')
    dynamic += [(5, 0x400000 + 512), (10, len(strings)), (0, 0)]
    dynamic_bytes = b''.join(struct.pack('<qQ', *pair) for pair in dynamic)
    data = bytearray(1024 + len(dynamic_bytes))
    data[:16] = b'\x7fELF\x02\x01\x01' + b'\0' * 9
    struct.pack_into('<HHIQQQIHHHHHH', data, 16, 3, 62, 1, 0, 64, 0, 0, 64, 56,
                     3 if interpreter else 2, 0, 0, 0)
    struct.pack_into('<IIQQQQQQ', data, 64, 1, 5, 0, 0x400000, 0, len(data), len(data), 4096)
    struct.pack_into('<IIQQQQQQ', data, 120, 2, 4, 1024, 0, 0, len(dynamic_bytes), len(dynamic_bytes), 8)
    if interpreter:
        raw = interpreter.encode() + b'\0'
        data[300:300 + len(raw)] = raw
        struct.pack_into('<IIQQQQQQ', data, 176, 3, 4, 300, 0, 0, len(raw), len(raw), 1)
    data[512:512 + len(strings)] = strings
    data[1024:] = dynamic_bytes
    return bytes(data)


def image_tar(path, files, links=None):
    with tarfile.open(path, 'w', format=tarfile.USTAR_FORMAT) as output:
        directories = set()
        for name in [*files, *(links or {})]:
            directories.update(p.as_posix() for p in Path(name).parents if p.as_posix() != '.')
        for name in sorted(directories):
            entry = tarfile.TarInfo(name)
            entry.type = tarfile.DIRTYPE
            output.addfile(entry)
        for name, data in files.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            output.addfile(entry, io.BytesIO(data))
        for name, target in (links or {}).items():
            entry = tarfile.TarInfo(name)
            entry.type, entry.linkname = tarfile.SYMTYPE, target
            output.addfile(entry)


class NativeTests(unittest.TestCase):
    def test_parse_native_metadata_without_loading(self):
        value = ELF(elf(['libssl.so.3', 'libc.so.6'], runpath='$ORIGIN/../lib',
                        interpreter='/lib64/ld-linux-x86-64.so.2'))
        self.assertEqual(value.needed, ['libssl.so.3', 'libc.so.6'])
        self.assertEqual(value.runpath, ['$ORIGIN/../lib'])
        value.compatible()

    def test_reject_architecture_ranges_loader_and_glibc(self):
        wrong_arch = bytearray(elf())
        struct.pack_into('<H', wrong_arch, 18, 183)
        cases = [wrong_arch, elf()[:90], elf(glibc='2.39'), elf(interpreter='/tmp/loader')]
        for data in cases:
            with self.subTest(data=hashlib.sha256(data).hexdigest()), self.assertRaises(ValueError):
                ELF(data).compatible()

    def test_reject_non_bare_dependency_and_relative_search(self):
        with self.assertRaises(ValueError):
            ELF(elf(['/tmp/lib.so']))
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            image_tar(root / 'image.tar', {'usr/local/lib/libfirst.so': elf()})
            image = Image(root / 'image.tar')
            try:
                package = Package(image, root / 'output', Path('/unused'))
                with self.assertRaisesRegex(ValueError, 'relative'):
                    package.resolve_dependency('bin/python', ELF(elf(runpath='.')), 'libfirst.so')
            finally:
                image.close()


class ImageTests(unittest.TestCase):
    def test_image_only_symlink_resolution(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'image.tar'
            image_tar(path, {'usr/lib/libok.so': b'contents'}, {'lib': 'usr/lib', 'absolute': '/lib/libok.so'})
            image = Image(path)
            try:
                self.assertEqual(image.read('absolute'), ('usr/lib/libok.so', b'contents'))
                with self.assertRaises(FileNotFoundError):
                    image.read('/etc/passwd')
            finally:
                image.close()

    def test_escaping_and_cyclic_links(self):
        for links in ({'escape': '../etc/passwd'}, {'a': 'b', 'b': 'a'}):
            with tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary) / 'image.tar'
                image_tar(path, {}, links)
                image = Image(path)
                try:
                    with self.assertRaises(ValueError):
                        image.read(next(iter(links)))
                finally:
                    image.close()

    def test_duplicate_paths_special_entries_and_oversized_extensions(self):
        for kind in ('duplicate', 'device', 'pax'):
            with tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary) / 'image.tar'
                with tarfile.open(path, 'w', format=tarfile.USTAR_FORMAT) as output:
                    entry = tarfile.TarInfo('a')
                    if kind == 'device':
                        entry.type = tarfile.CHRTYPE
                    elif kind == 'pax':
                        entry.type, entry.size = tarfile.XHDTYPE, 65537
                    output.addfile(entry, io.BytesIO(b'x' * entry.size))
                    if kind == 'duplicate':
                        output.addfile(entry)
                with self.assertRaises(ValueError):
                    Image(path)


class ClosureTests(unittest.TestCase):
    def test_every_transitive_object_gets_relative_runpath(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            files = {'usr/local/bin/python3.12': elf(['libpython.so']),
                     'usr/local/lib/libpython.so': elf(['libssl.so.3']),
                     'usr/lib/x86_64-linux-gnu/libssl.so.3': elf(['libcrypto.so.3']),
                     'usr/lib/x86_64-linux-gnu/libcrypto.so.3': elf(['libc.so.6']),
                     'usr/local/lib/python3.12/extension.so': elf(['libcrypto.so.3'])}
            image_tar(root / 'image.tar', files)
            image = Image(root / 'image.tar')
            try:
                package = Package(image, root / 'output', Path('/verified/patchelf'))
                package.copy('usr/local/bin/python3.12', 'runtime/bin/python')
                package.copy('usr/local/lib/python3.12/extension.so', 'runtime/lib/python3.12/extension.so')
                def patch_file(command, **kwargs):
                    target = Path(command[-1])
                    original = ELF(target.read_bytes())
                    target.write_bytes(elf(original.needed, runpath=command[-2]))
                with patch('host_runtime.package.subprocess.run', side_effect=patch_file):
                    package.close_native_dependencies()
                self.assertEqual(package.edges['runtime/lib/libssl.so.3']['libcrypto.so.3'],
                                 'runtime/lib/libcrypto.so.3')
                self.assertEqual(package.edges['runtime/lib/libcrypto.so.3']['libc.so.6'], 'host:libc.so.6')
                for name in package.elfs:
                    self.assertTrue(ELF((package.root / name).read_bytes()).runpath[0].startswith('$ORIGIN'))
                    self.assertIn('patched_sha256', package.sources[name])
            finally:
                image.close()

    def test_missing_library_never_uses_host(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            image_tar(root / 'image.tar', {'bin/python': elf(['libmissing.so'])})
            image = Image(root / 'image.tar')
            try:
                package = Package(image, root / 'output', Path('/unused'))
                package.copy('bin/python', 'runtime/bin/python')
                with self.assertRaisesRegex(ValueError, 'unresolved'):
                    package.close_native_dependencies()
            finally:
                image.close()


class ArchiveAndManifestTests(unittest.TestCase):
    def test_archive_is_deterministic_ustar_with_exact_inventory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            payload = root / 'payload'
            (payload / 'runtime').mkdir(parents=True)
            file = payload / 'runtime/fixture'
            file.write_bytes(b'fixture')
            file.chmod(0o444)
            inventory = archive(payload, root / 'first.tar')
            archive(payload, root / 'second.tar')
            self.assertEqual((root / 'first.tar').read_bytes(), (root / 'second.tar').read_bytes())
            self.assertEqual(inventory['runtime/fixture'], dict(sha256=digest(b'fixture'), size=7, mode='0444'))
            with tarfile.open(root / 'first.tar') as bundle:
                item = bundle.getmembers()[0]
                self.assertEqual((item.uid, item.gid, item.mtime, item.mode), (0, 0, 0, 0o444))
            (payload / 'runtime/link').symlink_to('/etc/passwd')
            with self.assertRaises(ValueError):
                archive(payload, root / 'bad.tar')

    def test_platform_python_are_independent_and_schema_is_exact(self):
        value = dict(schema_version=2, protocol=PROTOCOL,
                     source=dict(repository='free2z/zuu', commit='a' * 40),
                     build=dict(workflow=WORKFLOW, run_id='123', run_attempt=1),
                     web_release=dict(release_id='sha256:' + 'b' * 64, backend_digest='sha256:' + 'c' * 64),
                     platform=copy.deepcopy(PLATFORM),
                     runtime=dict(python=dict(implementation='cpython', version='3.12.15',
                                              soabi='cpython-312-x86_64-linux-gnu'), evidence='runtime/derivation.json'),
                     archive=dict(name='host-runtime.tar', size=10240, sha256='sha256:' + 'd' * 64,
                                  inventory_sha256='sha256:' + 'e' * 64))
        check(value)
        for mutate in (lambda v: v['platform'].update(python={}),
                       lambda v: v['runtime']['python'].update(soabi='cpython-311-x86_64-linux-gnu'),
                       lambda v: v['build'].update(run_attempt=True),
                       lambda v: v.update(deploy=True)):
            candidate = copy.deepcopy(value)
            mutate(candidate)
            with self.assertRaises(ValueError):
                check(candidate)


if __name__ == '__main__':
    unittest.main()
