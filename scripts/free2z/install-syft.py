#!/usr/bin/env python3
"""Install the reviewed Linux/amd64 Syft binary without executing an installer.

Archive SHA256 comes from the official v1.38.0 release's
syft_1.38.0_checksums.txt. Version and checksum changes require review together.
No cache, remote shell script, dependency resolution or archive extraction API
is used. Only the verified regular syft member is written to a new directory.
"""
import argparse
import hashlib
import io
from pathlib import Path
import platform
import tarfile
import urllib.parse
import urllib.request

VERSION = '1.38.0'
ARCHIVE = f'syft_{VERSION}_linux_amd64.tar.gz'
URL = f'https://github.com/anchore/syft/releases/download/v{VERSION}/{ARCHIVE}'
ARCHIVE_SHA256 = 'bc664debb00db1b9b4b9dae4ba1a29d99621e33b641b94b78b9048374b812a3d'
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_BINARY_BYTES = 128 * 1024 * 1024
MEMBERS = {'CHANGELOG.md', 'LICENSE', 'README.md', 'syft'}


def check_url(url):
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != 'https' or parsed.hostname not in {'github.com', 'release-assets.githubusercontent.com'}
            or parsed.username is not None or parsed.password is not None or parsed.port is not None):
        raise ValueError('unexpected Syft download origin')


class ReleaseRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download():
    check_url(URL)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), ReleaseRedirect())
    with opener.open(URL, timeout=30) as response:
        check_url(response.url)
        data = response.read(MAX_ARCHIVE_BYTES + 1)
    if len(data) > MAX_ARCHIVE_BYTES:
        raise ValueError('Syft archive exceeds download limit')
    return data


def verified_binary(data):
    if len(data) > MAX_ARCHIVE_BYTES or hashlib.sha256(data).hexdigest() != ARCHIVE_SHA256:
        raise ValueError('Syft archive checksum mismatch')
    seen = set()
    binary = None
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for member in archive:
            if member.name not in MEMBERS or member.name in seen or not member.isfile():
                raise ValueError('unexpected or unsafe Syft archive member')
            seen.add(member.name)
            limit = MAX_BINARY_BYTES if member.name == 'syft' else 1024 * 1024
            if member.size <= 0 or member.size > limit:
                raise ValueError('Syft archive member exceeds size limit')
            if member.name == 'syft':
                binary = archive.extractfile(member).read(limit + 1)
                if len(binary) != member.size:
                    raise ValueError('incomplete Syft binary')
    if seen != MEMBERS or binary is None:
        raise ValueError('incomplete Syft release archive')
    # ELF64 little-endian x86-64, matching the sole supported runner platform.
    if binary[:5] != b'\x7fELF\x02' or binary[5:6] != b'\x01' or binary[18:20] != b'\x3e\x00':
        raise ValueError('Syft archive does not contain the expected Linux/amd64 binary')
    return binary


def install(destination):
    if platform.system() != 'Linux' or platform.machine() != 'x86_64':
        raise ValueError('Syft installer supports only Linux/amd64 runners')
    binary = verified_binary(download())
    destination.mkdir(mode=0o755)  # Refuse reuse, symlinks and preexisting files.
    path = destination / 'syft'
    with path.open('xb') as output:
        output.write(binary)
    path.chmod(0o755)
    print(f'Installed Syft {VERSION}; archive SHA256 {ARCHIVE_SHA256}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('destination', type=Path)
    install(parser.parse_args().destination)
