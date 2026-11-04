import logging

from django.apps import AppConfig
from django.core.checks import Tags, register

logger = logging.getLogger(__name__)


class EmailsConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'dj.apps.emails'

    def ready(self):
        # The origin of every emailed link is security-critical configuration
        # with no safe default, so validate it rather than discover it
        # is wrong when an account-recovery mail lands with a dead link.
        from .checks import check_email_link_origin, check_email_sender

        register(Tags.security)(check_email_link_origin)

        # The From address is the other half of the same problem: a
        # sender outside the domain SendGrid signs for is accepted by the
        # provider, reported as sent, and then dropped by the recipient's
        # DMARC evaluation.
        register(Tags.security)(check_email_sender)

        # Registering the check covers `manage.py check` (CI) and the
        # management commands the deploy runs -- but gunicorn and daphne load
        # the WSGI/ASGI app WITHOUT running system checks, and the
        # per-namespace CANONICAL_ORIGIN comes from the k8s ConfigMap, which
        # no build-time command ever sees. So evaluate the same rule here too,
        # where the real deployed values are in scope.
        #
        # Log, do not raise: raising in ready() would crashloop every web,
        # worker and cron pod on the platform. The send path still fails hard
        # (link_origin raises ImproperlyConfigured), so nothing is silently
        # mailed with a wrong origin -- this is the "you will see it in the
        # logs the moment the pod starts" layer, not the enforcement layer.
        try:
            problems = check_email_link_origin(None)
        except Exception:  # pragma: no cover - defensive; never block startup
            logger.exception("emails: link-origin check itself failed")
        else:
            for problem in problems:
                logger.error(
                    "emails: outbound link origin config: %s", problem
                )

        # Same reasoning for the sender identity, and the same refusal to
        # raise: the send path fails hard on its own (sender.get_email_sender
        # raises ImproperlyConfigured), so nothing goes out unaligned.
        try:
            problems = check_email_sender(None)
        except Exception:  # pragma: no cover - defensive; never block startup
            logger.exception("emails: sender check itself failed")
        else:
            for problem in problems:
                logger.error("emails: outbound sender config: %s", problem)
