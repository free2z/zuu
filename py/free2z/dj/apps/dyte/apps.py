import logging

from django.apps import AppConfig

logger = logging.getLogger(__name__)


class DyteConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'dj.apps.dyte'

    def ready(self):
        # Say, once per serving process, which RealtimeKit credential mode
        # (v4 Bearer or legacy v2 Basic) this process will use and whether
        # its credentials are present -- never their values. Configuration
        # only: no DB, no network, and a diagnostic must never block boot.
        # One-shot commands are skipped (rtk_check_credentials prints its
        # own report).
        try:
            from dj.free2z.process_role import is_one_shot_command

            if is_one_shot_command():
                return
            from .client import log_auth_mode

            log_auth_mode(log=logger)
        except Exception:
            logger.exception('RealtimeKit API mode report failed')
