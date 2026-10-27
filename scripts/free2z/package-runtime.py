#!/usr/bin/env python3
"""Copy the explicit Python runtime surface; test configuration never ships."""
from pathlib import Path
import argparse
import shutil

MODULES = ('dj', 'twatter', 'gcp', 'utils', 'f2z', 'zcashrpc')
EXCLUDED = {'__pycache__', 'node_modules', '.venv', '.git', '.pytest_cache'}


def package(source: Path, destination: Path) -> list[str]:
    if destination.exists():
        raise ValueError('runtime destination must be absent')
    files = []
    for module in MODULES:
        directory = source / module
        if not directory.is_dir():
            raise ValueError(f'missing runtime module: {module}')
        for path in sorted(directory.rglob('*')):
            rel = path.relative_to(source)
            if path.is_symlink():
                raise ValueError(f'runtime symlink refused: {rel}')
            if not path.is_file() or EXCLUDED.intersection(rel.parts):
                continue
            if path.name.startswith(('test_', '.env')) or path.suffix in ('.pem', '.pyc', '.sqlite3'):
                continue
            files.append((path, rel))
    if not files:
        raise ValueError('empty runtime surface')
    for path, rel in files:
        out = destination / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, out)
    return [str(rel) for _, rel in files]


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    print(f'Packaged {len(package(args.source, args.destination))} runtime files')
