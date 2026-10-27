import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('install_syft', ROOT / 'scripts/free2z/install-syft.py')
syft = importlib.util.module_from_spec(spec)
spec.loader.exec_module(syft)
ELF = b'\x7fELF\x02\x01' + b'\x00' * 12 + b'\x3e\x00' + b'fixture'


def archive(extra=None, missing=None, binary=ELF):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w:gz') as output:
        for name in sorted(syft.MEMBERS - ({missing} if missing else set())):
            data = binary if name == 'syft' else b'license or documentation'
            member = tarfile.TarInfo(name)
            member.size = len(data)
            output.addfile(member, io.BytesIO(data))
        if extra:
            output.addfile(extra, io.BytesIO(b''))
    return stream.getvalue()


class SyftInstaller(unittest.TestCase):
    def verify_fixture(self, data):
        with mock.patch.object(syft, 'ARCHIVE_SHA256', hashlib.sha256(data).hexdigest()):
            return syft.verified_binary(data)

    def test_archive_checksum_is_required_before_parsing(self):
        data = archive()
        with mock.patch.object(syft.tarfile, 'open', side_effect=AssertionError('parsed unverified bytes')):
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                syft.verified_binary(data)

    def test_verified_allowlisted_binary_only(self):
        self.assertEqual(self.verify_fixture(archive()), ELF)
        data = archive()
        with tempfile.TemporaryDirectory() as root, mock.patch.object(syft, 'download', return_value=data), mock.patch.object(syft, 'ARCHIVE_SHA256', hashlib.sha256(data).hexdigest()), mock.patch.object(syft.platform, 'system', return_value='Linux'), mock.patch.object(syft.platform, 'machine', return_value='x86_64'):
            target = Path(root) / 'bin'
            syft.install(target)
            self.assertEqual([p.name for p in target.iterdir()], ['syft'])
            self.assertEqual((target / 'syft').read_bytes(), ELF)
            self.assertEqual((target / 'syft').stat().st_mode & 0o777, 0o755)
            with self.assertRaises(FileExistsError):
                syft.install(target)

    def test_unsafe_paths_links_duplicates_missing_and_wrong_platform_rejected(self):
        for name, kind in (('../escape', tarfile.REGTYPE), ('/absolute', tarfile.REGTYPE), ('syft', tarfile.REGTYPE), ('link', tarfile.SYMTYPE), ('hardlink', tarfile.LNKTYPE), ('directory', tarfile.DIRTYPE)):
            member = tarfile.TarInfo(name)
            member.type = kind
            member.linkname = '/tmp/escape'
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.verify_fixture(archive(extra=member))
        for data in (archive(missing='LICENSE'), archive(binary=b'not an ELF')):
            with self.assertRaises(ValueError):
                self.verify_fixture(data)

    def test_download_rejects_redirect_and_stream_overrun(self):
        with self.assertRaises(ValueError):
            syft.ReleaseRedirect().redirect_request(None, None, 302, '', {}, 'http://github.com/file')
        for url, content in (('https://evil.example/file', b'ok'), (syft.URL, b'too long')):
            response = io.BytesIO(content)
            response.url = url
            opener = mock.Mock()
            opener.open.return_value = response
            with mock.patch.object(syft.urllib.request, 'build_opener', return_value=opener), mock.patch.object(syft, 'MAX_ARCHIVE_BYTES', 2):
                with self.assertRaises(ValueError):
                    syft.download()

    def test_bounds_and_origins_are_enforced(self):
        data = archive()
        with mock.patch.object(syft, 'MAX_ARCHIVE_BYTES', len(data) - 1), self.assertRaises(ValueError):
            self.verify_fixture(data)
        with mock.patch.object(syft, 'MAX_BINARY_BYTES', len(ELF) - 1), self.assertRaises(ValueError):
            self.verify_fixture(data)
        for url in ('http://github.com/file', 'https://evil.example/file', 'https://github.com.evil.example/file', 'https://user@github.com/file', 'https://github.com:443/file'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                syft.check_url(url)
        syft.check_url(syft.URL)
        syft.check_url('https://release-assets.githubusercontent.com/release')


if __name__ == '__main__':
    unittest.main()
