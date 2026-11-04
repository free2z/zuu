import logging

from django.apps import AppConfig

logger = logging.getLogger(__name__)


class OpenaiConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'dj.apps.openai'

    def ready(self):
        #say, once per process, which AI providers have no key and
        # what translation will actually run as a result. Configuration only
        # -- no DB, no network -- so it is safe here and cannot slow boot.
        # It must never BLOCK boot either: a bug in a diagnostic is not a
        # reason for the API to stop serving.
        #
        #only in a process that serves. A one-shot `manage.py
        # <command>` (the payment host's credit loop runs two per cycle) never
        # translates, and the metric only counts the gunicorn container.
        try:
            from dj.free2z.process_role import is_one_shot_command

            if is_one_shot_command():
                return
            from dj.apps.g12f.translation.service import model_preference
            from f2z.ai.providers import log_availability

            log_availability(model_preference(), log=logger)
        except Exception:
            logger.exception('AI provider availability report failed')
