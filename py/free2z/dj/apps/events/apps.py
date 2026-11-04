from django.apps import AppConfig


class EventsConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'dj.apps.events'

    def ready(self):
        from .signals import send_to_pubsub  # noqa
