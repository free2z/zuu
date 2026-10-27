#!/usr/bin/env python3
"""Install one developer tool lock into a fresh, hash-verified environment."""
import argparse
from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile

KINDS = ('ci-audit', 'ci-lint', 'ci-policy', 'lock-tools', 'language-data')
ROOT = Path(__file__).resolve().parents[2]


def install(kind, *, verify_only=False, root=ROOT, execute=subprocess.run):
    if kind not in KINDS:
        raise ValueError('Unsupported developer tool lock')
    if sys.version_info[:2] != (3, 12):
        raise ValueError('Developer tool locks require Python 3.12, matching the backend image')
    directory = Path(tempfile.mkdtemp(prefix=f'free2z-{kind}-', dir=os.environ.get('RUNNER_TEMP')))
    interpreter = directory / 'bin' / 'python'
    try:
        execute([sys.executable, '-I', '-m', 'venv', str(directory)], check=True, stdout=sys.stderr, timeout=30)
        execute([str(interpreter), '-m', 'pip', 'install', '--disable-pip-version-check',
                 '--ignore-installed', '--only-binary=:all:', '--require-hashes',
                 '-r', str(root / 'py/free2z/requirements' / f'{kind}.txt')],
                check=True, stdout=sys.stderr, timeout=120)
        execute([str(interpreter), '-m', 'pip', 'check'], check=True, stdout=sys.stderr, timeout=15)
    except BaseException:
        shutil.rmtree(directory)
        raise
    if verify_only:
        shutil.rmtree(directory)
        return None
    return interpreter


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('kind', choices=KINDS)
    parser.add_argument('--verify-only', action='store_true', help='remove the verified temporary environment')
    options = parser.parse_args()
    result = install(options.kind, verify_only=options.verify_only)
    if result is not None:
        print(result)
