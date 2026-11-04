"""Management-command contracts for the pricing observability surface."""
from pathlib import Path
from types import SimpleNamespace




_REPO_ROOT = Path(__file__).resolve().parents[6]




def _snapshot(**overrides):
    payload = {
        "zec_usd": "1000.000000",
        "median_usd": "1000.000000",
        "num_sources": 3,
        "tuzis_per_zec": "90000.0000",
        "rejected": {"glitch": "1250.000000"},
    }
    payload.update(overrides)
    return SimpleNamespace(**payload)




