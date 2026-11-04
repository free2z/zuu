from django.apps import AppConfig


class TaggingConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'dj.apps.tagging'

    def ready(self):
        from . import signals  # noqa: F401
