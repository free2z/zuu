from django.apps import AppConfig


class E2eeConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "dj.apps.e2ee"
    label = "e2ee"

    def ready(self):
        from django.core.checks import register

        from .checks import check_chat_request_settings

        register(check_chat_request_settings)
