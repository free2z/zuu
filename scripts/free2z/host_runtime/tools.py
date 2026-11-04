"""Download immutable build tools; never used by the publishing job."""
import hashlib
import json
import tarfile
import tomllib
import urllib.parse
import urllib.request


class Redirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, url):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != 'https' or parsed.hostname not in (
                'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com',
                'static.rust-lang.org'):
            raise ValueError('unexpected build tool redirect')
        return super().redirect_request(request, fp, code, message, headers, url)


def install(repository, destination):
    lock = json.loads((repository / 'build/free2z/host-tools.json').read_text())
    rust = tomllib.loads((repository / 'rust-toolchain.toml').read_text())
    if rust['toolchain']['channel'] != lock['rust_version']:
        raise ValueError('host compiler lock differs from repository Rust authority')
    destination.mkdir(mode=0o700)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), Redirect())
    members = {'gh': 'gh_2.83.2_linux_amd64/bin/gh', 'patchelf': './bin/patchelf'}
    for name, tool in lock['tools'].items():
        archive = destination / (name + '.archive')
        total, digest = 0, hashlib.sha256()
        with opener.open(tool['url'], timeout=60) as response, archive.open('xb') as output:
            while block := response.read(1024 * 1024):
                total += len(block)
                if total > 512 * 1024 ** 2:
                    raise ValueError('tool download exceeds limit')
                digest.update(block)
                output.write(block)
        if digest.hexdigest() != tool['sha256']:
            raise ValueError('build tool checksum mismatch: ' + name)
        if name == 'rust':
            # The compiler archive is extracted only after checksum validation.
            with tarfile.open(archive) as bundle:
                bundle.extractall(destination, filter='data')
        else:
            with tarfile.open(archive) as bundle:
                entry = bundle.getmember(members[name])
                if not entry.isfile() or entry.size > 128 * 1024 ** 2:
                    raise ValueError('unexpected build tool member')
                with bundle.extractfile(entry) as source, (destination / name).open('xb') as output:
                    output.write(source.read())
            (destination / name).chmod(0o555)
        archive.unlink()
    return lock
