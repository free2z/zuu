#!/usr/bin/python3
"""Harmless hook: persist only lifecycle identities, not payment amounts or memos."""
import json
import os
import sqlite3
import sys

os.umask(0o077)
raw = sys.stdin.buffer.read(65_537)
if len(raw) > 65_536:
    raise ValueError("event exceeds example limit")
event = json.loads(raw)
if event["schema_version"] != 1 or event["kind"] not in {
    "payment.observed", "payment.confirmed", "payment.revoked"
}:
    raise ValueError("unsupported event")
# Supply a private directory owned by the hook user; this example creates no directories.
with sqlite3.connect(sys.argv[1]) as db:
    db.execute("CREATE TABLE IF NOT EXISTS received(event_id TEXT PRIMARY KEY, kind TEXT NOT NULL, revision INTEGER NOT NULL)")
    db.execute("INSERT OR IGNORE INTO received VALUES(?,?,?)", (
        event["event_id"], event["kind"], event["revision"]
    ))
# Context manager commits before exit zero, which acknowledges this delivery.
