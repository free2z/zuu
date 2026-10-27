"""Read a bounded Docker export without extracting paths or following host links."""
from pathlib import PurePosixPath
import tarfile

MAX_FILE = 256 * 1024 ** 2
MAX_IMAGE = 8 * 1024 ** 3


def canonical(path):
    parts = []
    for part in path.split('/'):
        if part in ('', '.'):
            continue
        if part == '..':
            if not parts:
                raise ValueError('image path escapes root')
            parts.pop()
        else:
            if '\\' in part or '\x00' in part:
                raise ValueError('invalid image path')
            parts.append(part)
    return '/'.join(parts)


class Image:
    def __init__(self, path):
        if path.stat().st_size > MAX_IMAGE:
            raise ValueError('image export too large')
        # tarfile decodes extension bodies before yielding members. Bound their
        # raw sizes first, including PAX/GNU metadata, without allocating them.
        with path.open('rb') as raw:
            count = 0
            while True:
                header = raw.read(512)
                if header == b'\0' * 512:
                    break
                if len(header) != 512:
                    raise ValueError('truncated image archive')
                info = tarfile.TarInfo.frombuf(header, 'utf-8', 'strict')
                count += 1
                maximum = MAX_FILE if info.isfile() else 65536
                if count > 200000 or not 0 <= info.size <= maximum:
                    raise ValueError('image archive header limit exceeded')
                raw.seek((info.size + 511) // 512 * 512, 1)
                if raw.tell() > path.stat().st_size:
                    raise ValueError('image entry exceeds archive')
        self.tar = tarfile.open(path, 'r:')
        self.entries = {}
        try:
            self._index()
        except BaseException:
            self.tar.close()
            raise

    def _index(self):
        expanded = 0
        for member in self.tar:
            name = canonical(member.name)
            if member.name.startswith('/') or name != member.name.rstrip('/'):
                raise ValueError('noncanonical image archive path')
            if name in self.entries or len(self.entries) >= 200000:
                raise ValueError('duplicate or excessive image entries')
            if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                raise ValueError('special image archive entry')
            if member.size > MAX_FILE or member.size < 0:
                raise ValueError('image file too large')
            expanded += member.size
            if expanded > MAX_IMAGE:
                raise ValueError('expanded image too large')
            self.entries[name] = member

    def resolve(self, path):
        name = canonical(path)
        visited = set()
        for _ in range(64):
            if name in visited:
                raise ValueError('image symlink cycle')
            visited.add(name)
            parts = name.split('/')
            for index in range(len(parts)):
                prefix = '/'.join(parts[:index + 1])
                entry = self.entries.get(prefix)
                if entry is None:
                    raise FileNotFoundError(name)
                if entry.issym() or entry.islnk():
                    target = entry.linkname
                    if entry.issym() and not target.startswith('/'):
                        target = str(PurePosixPath(prefix).parent / target)
                    name = canonical('/'.join([target, *parts[index + 1:]]))
                    break
                if index < len(parts) - 1 and not entry.isdir():
                    raise ValueError('non-directory image path component')
            else:
                return name
        raise ValueError('too many image symlinks')

    def read(self, path):
        name = self.resolve(path)
        member = self.entries[name]
        if not member.isfile():
            raise ValueError('expected regular image file: ' + name)
        with self.tar.extractfile(member) as stream:
            result = stream.read(MAX_FILE + 1)
        if len(result) != member.size:
            raise ValueError('truncated image file')
        return name, result

    def files(self, prefix):
        for name, entry in sorted(self.entries.items()):
            if name.startswith(prefix.rstrip('/') + '/') and not entry.isdir():
                resolved = self.resolve(name)
                if self.entries[resolved].isfile():
                    yield name

    def close(self):
        self.tar.close()
