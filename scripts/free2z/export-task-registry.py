#!/usr/bin/env python3
"""Export the committed task inventory after CI validates its live Django parity."""
from pathlib import Path
import argparse
import importlib.util
import json
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ROOT / 'scripts/free2z' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def export(commit):
    if not re.fullmatch('[0-9a-f]{40}', commit):
        raise ValueError('task inventory requires an exact source commit')
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    if head != commit:
        raise ValueError('task inventory source differs from checkout')
    subprocess.run(['git', 'diff', '--exit-code', 'HEAD', '--', 'py/free2z'], cwd=ROOT, check=True)
    untracked = subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard', '--', 'py/free2z'], cwd=ROOT, text=True)
    if untracked:
        raise ValueError('untracked application sources cannot enter a release inventory')
    checker = load('check-periodic-register-first')
    sources = checker.modules_at(commit)
    registered, schedules, unresolved = checker.scan(sources, strict=True)
    if unresolved:
        raise ValueError('task inventory contains unevaluable periodic declarations')
    registry = {'schema_version': 1, 'registered': sorted(registered), 'scheduled': sorted({task.name for task in schedules})}
    load('release-manifest').validate_task_registry(registry)
    return {'source': {'repository': 'free2z/zuu', 'commit': commit}, 'task_registry': registry}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    payload = json.dumps(export(args.commit), sort_keys=True, indent=2) + '\n'
    if len(payload.encode()) > 64 * 1024:
        raise ValueError('task inventory exceeds 64KiB')
    args.output.write_text(payload)
