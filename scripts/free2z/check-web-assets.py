#!/usr/bin/env python3
"""Refuse unresolved Git LFS pointers in every website build input."""
from pathlib import Path

INPUTS = ('py/free2z', 'ts/svelte/free2z', 'ts/react/free2z', 'ts/free2z/bridge', 'docs/about-free2z', 'docs/free2z/website')
IGNORED = {'node_modules', '.svelte-kit', '__pycache__', '.venv', '.git', 'build', 'docsbuild'}


def check(root):
    failures = []
    for name in INPUTS:
        for path in (root/name).rglob('*'):
            relative = path.relative_to(root)
            if IGNORED.intersection(relative.parts):
                continue
            if path.is_symlink():
                failures.append(str(relative) + ': symlink is not an explicit build input')
            elif path.is_file():
                with path.open('rb') as stream:
                    if stream.read(128).startswith(b'version https://git-lfs.github.com/spec/v1\n'):
                        failures.append(str(relative) + ': unresolved Git LFS pointer')
    if failures:
        raise ValueError('\n'.join(failures))


if __name__ == '__main__':
    check(Path(__file__).resolve().parents[2])
    print('Website build inputs contain no unresolved LFS pointers')
