#!/usr/bin/env python3
"""Generate/check the public hosted capability inventory from its live registry."""
import argparse
import json
import os
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / "py/free2z"))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "dj.free2z.settings")
import django  # noqa: E402
django.setup()
from dj.apps.mcpserver.catalog import operations, summary  # noqa: E402

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--check", action="store_true")
args = parser.parse_args()
rows = [summary(op) for op in sorted(operations())]
expected = json.dumps({"tool_count": 22, "supported_count": sum(row["supported"] for row in rows), "operations": rows}, ensure_ascii=False, indent=2) + "\n"
path = root / "docs/free2z/mcp/capabilities.json"
if args.check:
    if path.read_text() != expected:
        raise SystemExit("Hosted manifest differs; run scripts/free2z/mcp-capabilities.py")
else:
    path.write_text(expected)
