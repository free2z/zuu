"""Application and deployment provenance are independent health identities."""
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


@pytest.mark.parametrize("configured", [False, True])
def test_health_body_keeps_application_and_deployment_identity_separate(configured):
    env = dict(os.environ)
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[3])
    for name in ("BUILD_SHA", "DEPLOYMENT_SHA", "APP_RELEASE_ID"):
        env.pop(name, None)
    expected = {"ok": True, "commit": "dev", "deployment_commit": "dev", "release_id": "dev"}
    if configured:
        env.update(BUILD_SHA="a" * 40, DEPLOYMENT_SHA="b" * 40, APP_RELEASE_ID="sha256:" + "c" * 64)
        expected.update(commit=env["BUILD_SHA"], deployment_commit=env["DEPLOYMENT_SHA"], release_id=env["APP_RELEASE_ID"])
    result = subprocess.run(
        [sys.executable, "-c", "from dj.apps.health.middleware import _BODY; print(_BODY.decode())"],
        env=env, capture_output=True, text=True, check=True, timeout=15,
    )
    assert json.loads(result.stdout) == expected
    assert '"ok":true' in result.stdout
