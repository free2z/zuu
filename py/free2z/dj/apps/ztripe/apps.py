import logging

from django.apps import AppConfig
from django.core.checks import Tags, register

logger = logging.getLogger(__name__)


class ZtripeConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'dj.apps.ztripe'

    def ready(self):
        # CANONICAL_ORIGIN is the base of Stripe's success_url/cancel_url and
        # arrives from the per-namespace k8s ConfigMap. A malformed value
        # redirects a payer to a dead URL *after* they have paid. See checks.py
        # for why this lives in ztripe (it replaces coverage the efm WebAuthn
        # check used to provide by accident, before that app went offline in
        # ).
        from .checks import (
            check_canonical_origin,
            check_native_return_cache,
            check_native_return_origin,
        )

        register(Tags.security)(check_canonical_origin)
        register(Tags.security)(check_native_return_cache)
        register(Tags.security)(check_native_return_origin)

        # Registering the check covers `manage.py check` (CI) and the
        # management commands the deploy runs -- but neither of those sees the
        # value production actually gets. CI runs with the local-dev default,
        # and Cloud Build's collectstatic/migrate steps do not export
        # CANONICAL_ORIGIN either, so both validate the fallback. The real
        # per-namespace value only exists in the pod's environment, and
        # gunicorn/daphne load the app WITHOUT running system checks. So
        # evaluate the same rules here too, where the deployed value is in
        # scope -- this is the layer that would actually have caught a bad
        # ConfigMap.
        #
        # Log, do not raise: a bad return origin degrades checkout redirects,
        # while raising in ready() would crashloop every web, worker and cron
        # pod on the platform. This is the "you will see it in the logs the
        # moment the pod starts" layer, not the enforcement layer.
        self._report_live_credentials_outside_prod()

        try:
            problems = (
                check_canonical_origin(None) + check_native_return_origin(None)
            )
        except Exception:  # pragma: no cover - defensive; never block startup
            logger.exception("ztripe: CANONICAL_ORIGIN check itself failed")
            return
        for problem in problems:
            logger.error("ztripe: return-origin config: %s", problem)

    @staticmethod
    def _report_live_credentials_outside_prod():
        """: say so at boot when a non-prod pod holds live Stripe keys.

        Enforcement is ``stripe_checkout_enabled()``, which refuses checkout
        on every request whatever the switch says; this is the line an
        operator sees the moment the pod starts, once per process, with
        setting NAMES only.

        Log, do not raise. The free2z Secret is applied to every namespace
        before any pod rolls, so raising here would crashloop every web,
        worker and CronJob pod on stage -- the promotion gate for every prod
        release, hotfixes included -- over a condition the request-time
        guard already neutralises. Same reasoning as the return-origin check
        in ``ready()``.
        """
        try:
            from .stripe_identity import (
                live_stripe_credentials_outside_prod,
                log_live_credentials_outside_prod,
            )

            live = live_stripe_credentials_outside_prod()
            if live:
                log_live_credentials_outside_prod(live, where='startup')
        except Exception:  # pragma: no cover - defensive; never block startup
            logger.exception("ztripe: live-credential guard itself failed")
