#!/usr/bin/env python3
"""Capture runtime models and source-led writer calls for Free2Z.

Run with the backend venv and PYTHONPATH=py/free2z DJANGO_SETTINGS_MODULE=pytest_settings.
This is a bounded source inventory, not a claim to have audited every model's
behavior. --write records local source provenance, never deployed provenance.
"""
import argparse
import ast
import hashlib
import importlib
import inspect
import json
from pathlib import Path
import sys

import django
from django.apps import apps

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'py/free2z/dj/apps/economy/writer-register.json'
FINANCIAL_APPS = {'economy', 'ledger', 'tuzis', 'ztripe', 'purchases', 'pricing', 'dyte', 'kyc'}
FINANCIAL_G12F = {'creator', 'subscription', 'transaction', 'zpage', 'pagecomment'}
MUTATORS = {'debit', 'debit_up_to', 'credit', 'transfer', 'reserve', 'settle_reservation', 'release_reservation',
    'spend', 'spend_up_to', 'credit_purchase', 'credit_user', 'credit_with_repay', 'post_transfer',
    'transfer_users', 'refund_purchase', 'restore_purchase', 'clawback', 'lock_creator', 'lock_account', 'lock_in_order'}


def relative(path):
    resolved = Path(path).resolve()
    try:
        resolved.relative_to(ROOT / 'py/free2z')
    except ValueError:
        if 'site-packages' in resolved.parts:
            package_path = Path(*resolved.parts[resolved.parts.index('site-packages') + 1:])
            return 'installed:' + package_path.as_posix()
        return 'installed:' + resolved.name
    return str(resolved.relative_to(ROOT))


def snapshot():
    django.setup()
    # Operator commands import this actual unmanaged mapping lazily. Load it
    # explicitly so the census is independent of command/test import order.
    importlib.import_module('dj.apps.jobs.ops')
    models = []
    for model in apps.get_models(include_auto_created=False):
        metadata = model._meta
        source = relative(inspect.getfile(model))
        financial = metadata.app_label in FINANCIAL_APPS or (metadata.app_label == 'g12f' and metadata.model_name in FINANCIAL_G12F)
        models.append({'model': metadata.label, 'table': metadata.db_table, 'source': source,
            'review_scope': 'financial writer inventory' if financial else 'bounded source triage only',
            'disposition': 'financial model identified; per-path review required' if financial else 'no economic mutation established by model enumeration'})
    calls = []
    for path in sorted((ROOT / 'py/free2z/dj/apps').rglob('*.py')):
        if any(part in {'migrations', 'tests', '__pycache__'} for part in path.parts) or path.name.startswith('test_'):
            continue
        tree = ast.parse(path.read_text(), filename=str(path))
        aliases = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module in {'dj.apps.tuzis', 'dj.apps.ledger'}:
                aliases.update(alias.asname or alias.name for alias in node.names if alias.name in {'ledger', 'api'})
            if isinstance(node, ast.Import):
                aliases.update(alias.asname or alias.name for alias in node.names if alias.name in {'dj.apps.tuzis.ledger', 'dj.apps.ledger.api'})
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name):
                if node.func.value.id in aliases and node.func.attr in MUTATORS:
                    calls.append({'source': relative(path), 'line': node.lineno, 'call': node.func.value.id + '.' + node.func.attr,
                        'disposition': 'source writer identified; outer transaction order requires per-path review'})
    source_paths = {item['source'] for item in models + calls if not item['source'].startswith('installed:')}
    return {'kind': 'application source inventory; not deployed-state or production attestation',
        'inputs': {'python': f'{sys.version_info.major}.{sys.version_info.minor}',
                   'django': django.get_version(),
                   'dependency_lock': 'py/free2z/requirements/main.txt',
                   'dependency_lock_sha256': hashlib.sha256((ROOT / 'py/free2z/requirements/main.txt').read_bytes()).hexdigest()},
        'models': sorted(models, key=lambda item: item['model']),
        'writer_calls': sorted(calls, key=lambda item: (item['source'], item['line'])),
        'source_sha256': {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in sorted(source_paths)},
        'activation': 'Source inventory does not authorize production activation; reviewed drain and external writer deployment evidence is required'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true')
    args = parser.parse_args()
    result = snapshot()
    if args.write:
        OUTPUT.write_text(json.dumps(result, indent=2) + '\n')
        print(f'Recorded {len(result["models"])} runtime models and {len(result["writer_calls"])} source writer calls')
    else:
        print(json.dumps(result, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
