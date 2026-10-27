"""Startup validation of the  zPage variant flag pair.

``ZPAGE_VARIANT_READS`` and ``ZPAGE_VARIANT_DUAL_WRITE`` are not independent.
"Read variants, do not write them" is the one combination in which a creator's
write reaches nobody -- every save returns 200, every reader keeps seeing the
pre-edit article, and nothing logs -- so
:func:`dj.apps.g12f.variants.dual_write_enabled` ignores the dual-write switch
whenever reads are on.

Ignoring an operational switch is the right behaviour and a bad thing to do
quietly: the operator who set it did so deliberately, usually mid-incident, and
"I changed the config, restarted, and nothing happened" is the same silence
this guard exists to remove. This check is the startup half of saying so out
loud -- it runs under ``manage.py check`` (CI runs it on every PR, and Django
runs it for every management command, including the ones the deploy runs). The
runtime half lives in ``variants._warn_dual_write_is_ignored``, because
gunicorn and daphne load the WSGI/ASGI app WITHOUT running system checks and
these values arrive from the k8s ConfigMap, which no build-time command sees.

A ``Warning`` and not an ``Error`` on purpose: the value being ignored is the
SAFE direction (mirroring stays on, readers stay current), and ``manage.py
migrate`` is a Cloud Build step, so raising this to an Error would let a
config nit abort a production deploy -- including the deploy carrying the fix.

Registered from ``G12FConfig.ready()``.
"""

from __future__ import annotations

from django.conf import settings
from django.core.checks import Warning as CheckWarning


def check_zpage_variant_flags(app_configs, **kwargs):
    from dj.apps.g12f.localization import variant_reads_enabled

    if not variant_reads_enabled():
        return []
    if getattr(settings, "ZPAGE_VARIANT_DUAL_WRITE", True):
        return []
    return [
        CheckWarning(
            "ZPAGE_VARIANT_DUAL_WRITE is false but ZPAGE_VARIANT_READS is "
            "true, so the dual-write value is IGNORED and mirroring stays on.",
            hint=(
                "Readers resolve content out of ZPageVariant while "
                "ZPAGE_VARIANT_READS is on, which makes the mirror the only "
                "path from a creator's write to a reader's screen; turning it "
                "off there serves the whole site stale content while every "
                "write returns 200. To really stop mirroring, set BOTH keys "
                "to \"false\" in k8s/free2z/config.yaml in ONE edit and "
                "restart api + worker. See "
                "dj/apps/g12f/variants.py:dual_write_enabled (#980 M6, #1100)."
            ),
            id="g12f.W001",
        )
    ]
