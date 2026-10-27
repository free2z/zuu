"""Locate separately supplied deployment configuration without a fixed install depth."""
import os
from pathlib import Path


def deployment_root(module_path):
    """Use explicit configuration, or the legacy checkout/image deployment root.

    A source checkout may contain ``py/free2z`` and the runtime image installs
    the same modules directly under ``/py``. Deployment-only files are supplied
    separately; absent files never authorize a financial operation.
    """
    configured = os.environ.get('FREE2Z_DEPLOYMENT_ROOT')
    if configured:
        root = Path(configured)
        if not root.is_absolute():
            raise ValueError('FREE2Z_DEPLOYMENT_ROOT must be absolute')
        return root
    return next((parent.parent for parent in Path(module_path).resolve().parents
                 if parent.name == 'py'), Path('/'))
