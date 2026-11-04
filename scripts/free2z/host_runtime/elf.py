"""Bounded, non-executing inspection of little-endian Linux x86-64 ELF files."""
import re
import struct


class ELF:
    def __init__(self, data):
        self.needed, self.runpath, self.rpath, self.interpreter = [], [], [], None
        self.soname = None
        if len(data) < 64 or data[:7] != b'\x7fELF\x02\x01\x01':
            raise ValueError('expected ELF64 little-endian version 1')
        if struct.unpack_from('<H', data, 18)[0] != 62:
            raise ValueError('expected x86-64 ELF')
        if struct.unpack_from('<H', data, 16)[0] not in (2, 3):
            raise ValueError('expected executable or shared object')
        offset = struct.unpack_from('<Q', data, 32)[0]
        size, count = struct.unpack_from('<HH', data, 54)
        if size != 56 or not 0 < count <= 1024:
            raise ValueError('invalid ELF program header table')

        def span(start, length):
            if start < 0 or length < 0 or start + length > len(data):
                raise ValueError('ELF range outside file')
            return data[start:start + length]

        headers = [struct.unpack('<IIQQQQQQ', span(offset + i * size, size)) for i in range(count)]
        dynamic = []
        for kind, _, start, _, _, length, _, _ in headers:
            if kind == 3:
                if self.interpreter is not None or not 1 < length < 4096:
                    raise ValueError('invalid ELF interpreter')
                raw = span(start, length)
                if raw[-1:] != b'\0' or b'\0' in raw[:-1]:
                    raise ValueError('invalid ELF interpreter string')
                self.interpreter = raw[:-1].decode('ascii')
            if kind == 2:
                if dynamic or length % 16 or length > 1024 * 1024:
                    raise ValueError('invalid ELF dynamic section')
                for index in range(length // 16):
                    tag, value = struct.unpack('<qQ', span(start + index * 16, 16))
                    if tag == 0:
                        break
                    dynamic.append((tag, value))
                else:
                    raise ValueError('unterminated ELF dynamic section')
        strings = b''
        pointers = [v for t, v in dynamic if t == 5]
        lengths = [v for t, v in dynamic if t == 10]
        if dynamic:
            if len(pointers) != 1 or len(lengths) != 1 or lengths[0] > 16 * 1024 * 1024:
                raise ValueError('invalid ELF dynamic string table')
            candidates = [(start + pointers[0] - address, lengths[0])
                          for kind, _, start, address, _, length, _, _ in headers
                          if kind == 1 and address <= pointers[0]
                          and pointers[0] + lengths[0] <= address + length]
            if len(candidates) != 1:
                raise ValueError('ELF strings must map to exactly one load segment')
            strings = span(*candidates[0])

        def string(index):
            end = strings.find(b'\0', index)
            if index >= len(strings) or end < index or end - index > 4096:
                raise ValueError('invalid ELF dynamic string')
            return strings[index:end].decode('ascii')

        for tag, value in dynamic:
            if tag == 1:
                name = string(value)
                if not re.fullmatch(r'[A-Za-z0-9_+.\-]+', name):
                    raise ValueError('ELF dependency is not a bare library name')
                self.needed.append(name)
            if tag in (14, 15, 29):
                value = string(value)
                if tag == 14:
                    if self.soname is not None:
                        raise ValueError('duplicate SONAME')
                    self.soname = value
                elif tag == 15:
                    self.rpath = value.split(':')
                else:
                    self.runpath = value.split(':')
        # Version requirements live in .dynstr. A conservative ceiling also
        # rejects exported future glibc versions; no shell or loader is invoked.
        versions = re.findall(rb'\bGLIBC_([0-9]+)\.([0-9]+)(?:\.([0-9]+))?\x00', strings)
        self.glibc = sorted({tuple(int(x or 0) for x in v) for v in versions})
        if b'GLIBC_PRIVATE\0' in strings:
            raise ValueError('private glibc ABI is not a runtime contract')

    def compatible(self):
        if self.interpreter not in (None, '/lib64/ld-linux-x86-64.so.2'):
            raise ValueError('unsupported ELF interpreter')
        if any(version > (2, 36, 0) for version in self.glibc):
            raise ValueError('ELF requires newer than glibc 2.36')
