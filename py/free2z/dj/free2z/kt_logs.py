"""Which key-transparency log each deployment's handle authority signs for.

Every ``HandleAssertion`` embeds a ``log_id``. The log refuses an assertion
naming a different log as ``WrongLog`` -- and every health check stays green
while every enrollment fails -- so the value must match the log deployed in
the same namespace. These are the public ``log_id`` values from the
disposable-internal activation (``docs/k8s/f2z-servers.md`` §1.7,
free2z/zuu#1022 workstream 9). When a log is re-created, its ``log_id``
changes: update this table in the same change.

Public values. Nothing here is a secret.
"""

KT_LOG_IDS_BY_NAMESPACE = {
    "prod": "05b5dc5aa07ecae55442b8b32b6b8bebcc6490031112caa30adefa84070dc7e9",
    "stage": "5d84130eb8004c1ee642ca0e0accb53e2a17b721febea68ac60de9b43c134f61",
    "test": "3d8fbbad4948f525a9036206463407cc9f80da21b5e7bb7d5746afdf5d9e665a",
}


def resolve_kt_log_id_hex(namespace, override) -> str:
    """``override`` if set, else the table entry for ``namespace``, else "".

    ``namespace`` is the raw ``NAMESPACE`` environment variable, **not** the
    settings default: a local checkout or CI run with no ``NAMESPACE`` must stay
    unconfigured rather than silently claim to be the test deployment.
    """
    if override:
        return override
    return KT_LOG_IDS_BY_NAMESPACE.get(namespace or "", "")
