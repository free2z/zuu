"""Reviewed byte-specific relocations for dynamic loaders outside ELF DT_NEEDED."""
import hashlib

# psycopg 3.3.6, psycopg/pq/misc.py, verified against both its upstream tag
# and PyPI wheel a1db9f7148b06a28606767efaca51fa6f9398c5c0a3810519be69d7000bdb631.
# A dependency update requires reviewing this relocation again.
PSYCOPG_MISC_SHA256 = '7feab07068b7853ae6f7890bfd2100c598fc9e7e42edb2571d2c413339a805f0'
PSYCOPG_ORIGINAL = b'        libname = ctypes.util.find_library("pq")\n'
PSYCOPG_REPLACEMENT = b'''        runtime_lib = Path(__file__).resolve(strict=True).parents[4]
        libpq = runtime_lib / "libpq.so.5"
        if libpq.is_symlink() or not libpq.is_file():
            raise ImportError("bundled libpq is missing or is a symlink")
        libname = str(libpq)
'''


def psycopg(data):
    if hashlib.sha256(data).hexdigest() != PSYCOPG_MISC_SHA256 or data.count(PSYCOPG_ORIGINAL) != 1:
        raise ValueError('psycopg resolver differs from reviewed upstream bytes')
    return data.replace(PSYCOPG_ORIGINAL, PSYCOPG_REPLACEMENT)
