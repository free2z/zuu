"""Adversarial packaging tests; no payload execution, network, or third-party modules."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tomllib
import tarfile
import tempfile
import textwrap
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from host_runtime.elf import ELF
from host_runtime.image import Image
from host_runtime.manifest import check, PROTOCOL, WORKFLOW
from host_runtime.package import PLATFORM, Package, archive, digest
from host_runtime import licenses, package, provenance, relocation

ROOT = Path(__file__).resolve().parents[3]


def load(filename):
    spec = importlib.util.spec_from_file_location(filename, ROOT / 'scripts/free2z' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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


def tzif(hours):
    # Minimal fixed-offset TZif v1 file: one local-time type, no transitions.
    return b'TZif\0' + b'\0' * 15 + struct.pack('>6I', 0, 0, 0, 0, 1, 4) + struct.pack('>lbb', hours * 3600, 0, 0) + b'TST\0'


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

    def test_private_glibc_abi_is_never_a_payload_contract(self):
        with self.assertRaisesRegex(ValueError, 'private glibc ABI'):
            ELF(elf(glibc='PRIVATE'))

    @unittest.skipUnless(sys.platform == 'linux' and Path('/lib/x86_64-linux-gnu/libmvec.so.1').is_file(),
                         'requires the actual Linux x86-64 glibc vector library')
    def test_actual_glibc_vector_library_cannot_be_bundled(self):
        with self.assertRaisesRegex(ValueError, 'private glibc ABI'):
            ELF(Path('/lib/x86_64-linux-gnu/libmvec.so.1').read_bytes())

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
    def test_vector_math_is_an_exact_host_edge_not_a_bundled_private_abi(self):
        self.assertEqual(set(package.SYSTEM_LIBRARIES), load('host-runtime-qualify.py').SYSTEM)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            image_tar(root / 'image.tar', {
                'usr/local/lib/libcodec.so': elf(['libmvec.so.1', 'libm.so.6']),
                'usr/lib/x86_64-linux-gnu/libmvec.so.1': elf(glibc='PRIVATE'),
            })
            image = Image(root / 'image.tar')
            try:
                bundle = Package(image, root / 'output', Path('/verified/patchelf'))
                bundle.copy('usr/local/lib/libcodec.so', 'runtime/lib/libcodec.so')
                def patch_file(command, **kwargs):
                    target = Path(command[-1])
                    target.write_bytes(elf(ELF(target.read_bytes()).needed, runpath=command[-2]))
                with patch('host_runtime.package.subprocess.run', side_effect=patch_file):
                    bundle.close_native_dependencies()
                self.assertEqual(bundle.edges['runtime/lib/libcodec.so']['libmvec.so.1'], 'host:libmvec.so.1')
                self.assertNotIn('runtime/lib/libmvec.so.1', bundle.sources)
                self.assertFalse((bundle.root / 'runtime/lib/libmvec.so.1').exists())
                # Direct copies and similarly named libraries do not inherit
                # the host exemption. Neither can carry a private ABI payload.
                with self.assertRaisesRegex(ValueError, 'private glibc ABI'):
                    bundle.copy('usr/lib/x86_64-linux-gnu/libmvec.so.1', 'runtime/lib/libmvec.so.1')
            finally:
                image.close()

    def test_unapproved_vector_library_still_rejects_private_abi_with_source_context(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            image_tar(root / 'image.tar', {
                'usr/local/lib/libcodec.so': elf(['libmvec.so.2']),
                'usr/lib/x86_64-linux-gnu/libmvec.so.2': elf(glibc='PRIVATE'),
            })
            image = Image(root / 'image.tar')
            try:
                bundle = Package(image, root / 'output', Path('/unused'))
                bundle.copy('usr/local/lib/libcodec.so', 'runtime/lib/libcodec.so')
                with self.assertRaisesRegex(ValueError, r'libcodec.so -> libmvec.so.2 .*private glibc ABI'):
                    bundle.close_native_dependencies()
            finally:
                image.close()

    def test_installed_development_objects_do_not_enter_runtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            development = bytearray(elf())
            struct.pack_into('<H', development, 16, 1)  # ET_REL, not a runnable ELF
            files = {'usr/local/bin/python3.12': elf(['libc.so.6']),
                     'usr/lib/x86_64-linux-gnu/libpq.so.5': elf(['libc.so.6']),
                     'usr/local/lib/python3.12/config-3.12-x86_64-linux-gnu/python.o': bytes(development),
                     'usr/local/lib/python3.12/config-3.12-x86_64-linux-gnu/libpython.a': b'archive',
                     'usr/local/lib/python3.12/site-packages/psycopg/pq/misc.py': b'fixture resolver',
                     'usr/local/lib/python3.12/LICENSE.txt': b'fixture license',
                     'py/dj/free2z/manage.py': b'# fixture', 'py/zcashrpc/paymentd_mode.py': b'# fixture',
                     'usr/share/zoneinfo/UTC': tzif(0),
                     'usr/share/zoneinfo/Asia/Tokyo': tzif(9),
                     'usr/share/doc/tzdata/copyright': b'fixture timezone copyright',
                     'etc/os-release': b'ID=debian\nVERSION_ID="12"\n',
                     'etc/ssl/certs/ca-certificates.crt': b'fixture'}
            image_tar(root / 'image.tar', files)
            daemon = root / 'daemon'
            daemon.write_bytes(elf(['libc.so.6']))
            licenses = root / 'licenses'
            licenses.mkdir()
            (licenses / 'packages.json').write_text('[]')
            def patch_file(command, **kwargs):
                target = Path(command[-1])
                target.write_bytes(elf(ELF(target.read_bytes()).needed, runpath=command[-2]))
            with patch('host_runtime.package.subprocess.run', side_effect=patch_file), \
                    patch('host_runtime.relocation.psycopg', side_effect=lambda data: data):
                package.prepare(root / 'image.tar', root / 'output', daemon, Path('/verified/patchelf'), {}, licenses)
            self.assertFalse(list((root / 'output').rglob('*.o')))
            self.assertFalse(list((root / 'output').rglob('*.a')))
            self.assertTrue((root / 'output/runtime/lib/python3.12/LICENSE.txt').is_file())
            self.assertEqual((root / 'output/runtime/share/zoneinfo/UTC').read_bytes(), tzif(0))
            evidence = json.loads((root / 'output/runtime/derivation.json').read_text())
            self.assertEqual(evidence['files']['runtime/share/zoneinfo/Asia/Tokyo'],
                             dict(source='image:/usr/share/zoneinfo/Asia/Tokyo', sha256=digest(tzif(9))))

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


class ProvenanceAndRelocationTests(unittest.TestCase):
    def test_numeric_identity_and_exact_run_attempt_are_required(self):
        build = dict(run_id='1234', run_attempt=2)
        certificate = dict(runInvocationURI='https://github.com/free2z/zuu/actions/runs/1234/attempts/2',
                           sourceRepositoryIdentifier='463741105', sourceRepositoryOwnerIdentifier='102555797')
        def result(value):
            return [dict(verificationResult=dict(signature=dict(certificate=value)))]
        provenance.matches_certificate(result(certificate), build)
        for key in certificate:
            bad = {**certificate, key: 'wrong'}
            with self.assertRaises(ValueError):
                provenance.matches_certificate(result(bad), build)
        split = result({**certificate, 'sourceRepositoryIdentifier': 'wrong'})
        split += result({**certificate, 'runInvocationURI': 'https://github.com/free2z/zuu/actions/runs/1234/attempts/1'})
        with self.assertRaises(ValueError):
            provenance.matches_certificate(split, build)
        # Unrelated valid witnesses do not erase the matching witness.
        provenance.matches_certificate(result({}) + result(certificate), build)

    def test_old_web_source_is_rejected_before_download(self):
        with patch('host_runtime.provenance.command') as command:
            with self.assertRaises(ValueError):
                provenance.verify(ROOT, Path('/unused'), 'free2z-web-' + 'b' * 40 + '-123-1',
                                  'a' * 40, Path('/not-created'))
            command.assert_not_called()

    def test_same_checkout_and_manual_protected_main_are_required(self):
        producer = load('host-runtime.py')
        good = dict(GITHUB_SHA='a' * 40, GITHUB_REPOSITORY='free2z/zuu',
                    GITHUB_REF='refs/heads/main', GITHUB_REF_PROTECTED='true', GITHUB_EVENT_NAME='workflow_dispatch')
        with patch.dict('os.environ', good, clear=True), patch('subprocess.check_output', return_value='a' * 40 + '\n'):
            self.assertEqual(producer.identity(), 'a' * 40)
            for key, bad in [('GITHUB_SHA', 'b' * 40), ('GITHUB_REPOSITORY', 'fork/zuu'),
                             ('GITHUB_REF', 'refs/tags/main'), ('GITHUB_REF_PROTECTED', 'false'),
                             ('GITHUB_EVENT_NAME', 'workflow_run')]:
                with patch.dict('os.environ', {key: bad}), self.assertRaises(ValueError):
                    producer.identity()

    def test_only_interpreter_locale_initialization_is_permitted(self):
        qualify = load('host-runtime-qualify.py')
        self.assertEqual(qualify.SYSTEM, set(PLATFORM['system_libraries']))
        self.assertIn('libresolv.so.2', qualify.SYSTEM)
        qualify.check_startup_environment({})
        qualify.check_startup_environment({'LC_CTYPE': 'C.UTF-8'})
        for environment in ({'PYTHONPATH': '/tmp'}, {'LD_LIBRARY_PATH': '/tmp'}, {'LC_CTYPE': 'other'}):
            with self.assertRaises(ValueError):
                qualify.check_startup_environment(environment)

    def test_resolver_relocation_is_exact_and_has_no_host_fallback(self):
        with self.assertRaises(ValueError):
            relocation.psycopg(b'arbitrary upstream bytes')
        body = b'def locate():\n    if True:\n' + relocation.PSYCOPG_ORIGINAL + b'    return libname\n'
        with patch.object(relocation, 'PSYCOPG_MISC_SHA256', hashlib.sha256(body).hexdigest()):
            transformed = relocation.psycopg(body)
        self.assertNotIn(b'find_library', transformed)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'runtime/lib/python3.12/site-packages/psycopg/pq/misc.py'
            source.parent.mkdir(parents=True)
            source.write_bytes(transformed)
            library = root / 'runtime/lib/libpq.so.5'
            namespace = dict(Path=Path, __file__=str(source))
            exec(compile(transformed, str(source), 'exec'), namespace)
            with self.assertRaises(ImportError):
                namespace['locate']()
            library.write_bytes(b'fixture')
            self.assertEqual(namespace['locate'](), str(library.resolve()))
            library.unlink()
            library.symlink_to(source)
            with self.assertRaises(ImportError):
                namespace['locate']()

    def test_compiler_lock_tracks_repository_authority(self):
        import json
        tool_lock = json.loads((ROOT / 'build/free2z/host-tools.json').read_text())
        rust = tomllib.loads((ROOT / 'rust-toolchain.toml').read_text())
        self.assertEqual(tool_lock['rust_version'], rust['toolchain']['channel'])
        for value in tool_lock['tools'].values():
            self.assertRegex(value['sha256'], r'^[a-f0-9]{64}$')
            self.assertTrue(value['url'].startswith('https://'))


class NameServiceQualificationTests(unittest.TestCase):
    def test_profile_excludes_external_providers_and_implicit_defaults(self):
        qualify = load('host-runtime-qualify.py')
        profile = (ROOT / 'build/free2z/host-nsswitch.conf').read_bytes()
        self.assertEqual(qualify.check_nss_profile(profile), digest(profile))
        for changed in (profile.replace(b'passwd: files', b'passwd: files remote'),
                        profile.replace(b'netgroup: files\n', b''),
                        profile + b'hosts: files dns\n',
                        profile.replace(b'group: files\n', b'group: files [SUCCESS=merge]\n'),
                        profile.rstrip(b'\n')):
            with self.subTest(profile=changed), self.assertRaisesRegex(ValueError, 'complete explicit'):
                qualify.check_nss_profile(changed)

    def test_nscd_socket_and_broken_link_are_rejected(self):
        qualify = load('host-runtime-qualify.py')
        # Keep the Unix-domain pathname below the platform's sockaddr limit.
        with tempfile.TemporaryDirectory(dir='/tmp', prefix='nss-') as temporary:
            endpoint = Path(temporary) / 'socket'
            qualify.check_nscd_absent([endpoint])
            with socket.socket(socket.AF_UNIX) as cache:
                cache.bind(str(endpoint))
                with self.assertRaisesRegex(ValueError, 'nscd'):
                    qualify.check_nscd_absent([endpoint])
            endpoint.unlink()
            endpoint.symlink_to(Path(temporary) / 'missing')
            with self.assertRaisesRegex(ValueError, 'nscd'):
                qualify.check_nscd_absent([endpoint])
            endpoint.unlink()
            qualify.check_nscd_absent([endpoint])


class PublicationRecoveryTests(unittest.TestCase):
    def publication(self, failure=None):
        producer = load('host-runtime.py')
        events = []
        tag = 'free2z-host-' + 'a' * 40 + '-123-1'

        class Connection:
            def __init__(self, host, timeout):
                self.host, self.method, self.name = host, None, None
                self.uploaded = bytearray()

            def request(self, method, path, body, headers):
                self.method = method
                value = json.loads(body)
                events.append((method, value.get('draft')))

            def putrequest(self, method, path):
                self.name = path.split('?name=')[1]

            def putheader(self, *args):
                pass

            def endheaders(self):
                pass

            def send(self, block):
                self.uploaded.extend(block)

            def getresponse(self):
                if self.host == 'api.github.com':
                    value = dict(id=11, draft=self.method == 'POST', tag_name=tag, target_commitish='a' * 40)
                    status = 201 if self.method == 'POST' else 200
                else:
                    events.append(('upload', self.name))
                    value = dict(name=self.name, state='uploaded', size=len(self.uploaded),
                                 digest=digest(self.uploaded) if failure != 'digest' else 'sha256:' + '0' * 64)
                    status = 503 if failure == 'http' else 201
                return SimpleNamespace(status=status, read=lambda limit: json.dumps(value).encode())

            def close(self):
                pass

        with patch.object(producer, 'check'), patch.object(producer, 'identity', return_value='a' * 40), \
                patch.dict('os.environ', dict(GITHUB_RUN_ID='123', GITHUB_RUN_ATTEMPT='1', GH_TOKEN='synthetic'), clear=True), \
                patch('pathlib.Path.is_symlink', return_value=False), patch('pathlib.Path.is_file', return_value=True), \
                patch('pathlib.Path.stat', return_value=SimpleNamespace(st_size=1)), \
                patch('pathlib.Path.open', side_effect=lambda *args, **kwargs: io.BytesIO(b'x')), \
                patch.object(producer.http.client, 'HTTPSConnection', Connection):
            if failure:
                with self.assertRaises(ValueError):
                    producer.publish(SimpleNamespace(output=Path('/synthetic')))
            else:
                producer.publish(SimpleNamespace(output=Path('/synthetic')))
        return events

    def test_complete_assets_are_verified_before_publication(self):
        events = self.publication()
        self.assertEqual(events[0], ('POST', True))
        self.assertEqual(events[-1], ('PATCH', False))
        self.assertEqual(len([entry for entry in events if entry[0] == 'upload']), 14)

    def test_upload_error_or_wrong_digest_cannot_publish(self):
        for failure in ('http', 'digest'):
            events = self.publication(failure)
            self.assertEqual(events[0], ('POST', True))
            self.assertFalse(any(entry[0] == 'PATCH' for entry in events))

    def test_partial_rerun_fails_with_explicit_full_workflow_recovery(self):
        workflow = (ROOT / '.github/workflows/free2z-host-release.yml').read_text()
        guard = workflow.split('- name: Require the build and publisher to share one attempt', 1)[1]
        script = textwrap.dedent(guard.split('        run: |', 1)[1].split('      - ', 1)[0])
        for built, publishing, expected in [('1', '1', 0), ('2', '2', 0), ('1', '2', 1), ('', '2', 1)]:
            result = subprocess.run(['bash', '-c', script], capture_output=True, text=True,
                                    env=dict(BUILT_ATTEMPT=built, GITHUB_RUN_ATTEMPT=publishing), timeout=10)
            self.assertEqual(result.returncode, expected)
            if expected:
                self.assertIn('Re-run all jobs', result.stdout)


class LicenseEvidenceTests(unittest.TestCase):
    def fixture(self, root, files, supplemented=False):
        crate = 'fixture-1.0.0'
        cache = root / 'cargo/registry/cache/example'
        cache.mkdir(parents=True)
        contents = {'Cargo.toml': b'[package]\nname="fixture"\nversion="1.0.0"\nlicense="MIT"\n',
                    '.cargo_vcs_info.json': json.dumps({'git': {'sha1': 'a' * 40}}).encode(), **files}
        archive = cache / (crate + '.crate')
        with tarfile.open(archive, 'w') as stream:
            for name, data in contents.items():
                info = tarfile.TarInfo(crate + '/' + name)
                info.size = len(data)
                stream.addfile(info, io.BytesIO(data))
        checksum = licenses.sha(archive.read_bytes())
        project = root / 'rs/zcash-payment-hooks'
        project.mkdir(parents=True)
        (project / 'Cargo.lock').write_text('[[package]]\nname="fixture"\nversion="1.0.0"\n'
                                          f'source="{licenses.REGISTRY}"\nchecksum="{checksum}"\n')
        supplements = root / 'build/free2z/host-licenses'
        supplements.mkdir(parents=True)
        rows = []
        if supplemented:
            text = b'Exact upstream license text fixture\n'
            path = supplements / crate / 'LICENSE'
            path.parent.mkdir()
            path.write_bytes(text)
            rows.append(dict(name='fixture', version='1.0.0', checksum=checksum, license='MIT',
                             repository='https://github.com/example/fixture', commit='a' * 40,
                             basis=dict(kind='crate-vcs-info', commit='a' * 40),
                             files=[dict(path=crate + '/LICENSE', sha256=licenses.sha(text),
                                         upstream_url='https://raw.githubusercontent.com/example/fixture/' + 'a' * 40 + '/LICENSE')]))
        manifest = supplements / 'manifest.json'
        manifest.write_text(json.dumps(dict(schema_version=1, packages=rows)))
        metadata = dict(packages=[dict(name='fixture', version='1.0.0', source=licenses.REGISTRY, license='MIT')])
        return metadata, manifest, archive

    def test_archive_licenses_and_authors_are_preserved_with_supplements(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            metadata, _, _ = self.fixture(root, {'LICENSE': b'Archive-owned license', 'AUTHORS': b'Authors'}, True)
            licenses.collect(root, metadata, root / 'cargo', root / 'out')
            target = root / 'out/fixture-1.0.0'
            self.assertEqual((target / 'LICENSE').read_bytes(), b'Archive-owned license')
            self.assertEqual((target / 'AUTHORS').read_bytes(), b'Authors')
            self.assertEqual((target / 'upstream/LICENSE').read_bytes(), b'Exact upstream license text fixture\n')
            inventory = json.loads((root / 'out/packages.json').read_text())[0]['files']
            for path, expected in inventory.items():
                self.assertEqual('sha256:' + licenses.sha((target / path).read_bytes()), expected)

    def test_unknown_missing_license_and_authors_only_fail(self):
        for files in ({}, {'AUTHORS': b'Authors without any license grant'}):
            with self.subTest(files=files), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                metadata, _, _ = self.fixture(root, files)
                with self.assertRaisesRegex(ValueError, 'no reviewed license'):
                    licenses.collect(root, metadata, root / 'cargo', root / 'out')

    def test_exact_supplement_fills_missing_archive_license(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            metadata, _, _ = self.fixture(root, {}, True)
            licenses.collect(root, metadata, root / 'cargo', root / 'out')
            self.assertTrue((root / 'out/fixture-1.0.0/upstream/provenance.json').is_file())

    def test_changed_archive_or_supplement_identity_and_bytes_fail(self):
        for mutation in ('archive', 'checksum', 'text', 'vcs', 'license', 'missing', 'url'):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                metadata, path, archive = self.fixture(root, {}, True)
                value = json.loads(path.read_text())
                row = value['packages'][0]
                if mutation == 'archive':
                    with archive.open('ab') as output:
                        output.write(b'changed')
                elif mutation == 'checksum':
                    row['checksum'] = '0' * 64
                elif mutation == 'text':
                    row['files'][0]['sha256'] = '0' * 64
                elif mutation == 'vcs':
                    row['commit'] = 'b' * 40
                    row['basis']['commit'] = 'b' * 40
                    row['files'][0]['upstream_url'] = row['files'][0]['upstream_url'].replace('a' * 40, 'b' * 40)
                elif mutation == 'license':
                    row['license'] = 'Apache-2.0'
                elif mutation == 'missing':
                    value['packages'] = []
                elif mutation == 'url':
                    row['files'][0]['upstream_url'] = 'https://example.invalid/LICENSE'
                path.write_text(json.dumps(value))
                with self.assertRaises(ValueError):
                    licenses.collect(root, metadata, root / 'cargo', root / 'out')

    def test_checked_in_supplements_match_locked_inputs(self):
        locked = {(p['name'], p['version'], p.get('source')): p.get('checksum')
                  for p in tomllib.loads((ROOT / 'rs/zcash-payment-hooks/Cargo.lock').read_text())['package']}
        rows = licenses.load_supplements(ROOT / 'build/free2z/host-licenses', locked)
        self.assertEqual(len(rows), 14)
        self.assertIn('host_runtime/licenses.py', (ROOT / 'scripts/free2z/host-rust-build.sh').read_text())
        self.assertIn("'build/free2z/host-licenses'", (ROOT / 'scripts/free2z/host-runtime.py').read_text())


class TimezoneQualificationTests(unittest.TestCase):
    def qualify(self, root):
        script = ('import runpy,sys; '
                  'm=runpy.run_path(sys.argv[1]); '
                  'm["select_bundled_timezones"](m["Path"](sys.argv[2]))')
        return subprocess.run([sys.executable, '-I', '-S', '-c', script,
                               str(ROOT / 'scripts/free2z/host-runtime-qualify.py'), str(root)],
                              capture_output=True, text=True, env={}, timeout=15)

    def test_isolated_timezone_resolution_relocates_at_two_prefixes(self):
        with tempfile.TemporaryDirectory() as temp:
            for prefix in ('one', 'unrelated/deeper/two'):
                root = Path(temp) / prefix
                zoneinfo = root / 'runtime/share/zoneinfo'
                (zoneinfo / 'Asia').mkdir(parents=True)
                (zoneinfo / 'UTC').write_bytes(tzif(0))
                (zoneinfo / 'Asia/Tokyo').write_bytes(tzif(9))
                result = self.qualify(root)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_missing_or_wrong_bundle_timezone_cannot_use_host_data(self):
        for missing, offset in ((True, 9), (False, 0)):
            with self.subTest(missing=missing, offset=offset), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                zoneinfo = root / 'runtime/share/zoneinfo'
                (zoneinfo / 'Asia').mkdir(parents=True)
                if not missing:
                    (zoneinfo / 'UTC').write_bytes(tzif(0))
                (zoneinfo / 'Asia/Tokyo').write_bytes(tzif(offset))
                result = self.qualify(root)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('ZoneInfoNotFoundError' if missing else 'unexpected offset', result.stderr)


if __name__ == '__main__':
    unittest.main()
