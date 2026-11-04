"""The handle-authority signing key reaches the API server and nothing else.

``ktauth`` fetches the Ed25519 seed at boot in any process that has
``KT_AUTHORITY_SECRET_NAME`` set. Two things keep that to the API server, and
both are manifest properties no Django test would otherwise notice:

1. Only the API Deployment's gunicorn container sets the variable -- not
   Daphne in the same pod, not a worker, subscriber, cron job or job.
2. The API pod runs as its own ``free2z-api`` ServiceAccount, mapped to a
   per-namespace GCP account that alone holds ``secretAccessor`` on the key.
   Every other workload keeps ``free2z-db``, which does not.
"""

import re

import yaml

VAR = "KT_AUTHORITY_SECRET_NAME"


def _documents(path):
    # A placeholder alone on a line stands for a whole YAML block (e.g. an env
    # list fragment); drop it. Inline placeholders become visible markers.
    text = re.sub(r"(?m)^[ \t]*%\{[A-Z_]+\}[ \t]*$", "", path.read_text())
    text = re.sub(r"%\{([A-Z_]+)\}", lambda m: f"<{m.group(1)}>", text)
    return [d for d in yaml.safe_load_all(text) if isinstance(d, dict)]


def _pod_specs(doc):
    spec = doc.get("spec") or {}
    if doc.get("kind") == "CronJob":
        spec = spec.get("jobTemplate", {}).get("spec", {})
    template = spec.get("template") or {}
    pod = template.get("spec")
    return [pod] if pod else []




def _env_names(container):
    return {e.get("name") for e in container.get("env") or []}








