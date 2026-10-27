from django.apps import AppConfig


class CommentsConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'dj.apps.comments'

    def ready(self):
        from .signals import send_comment_to_pubsub  # noqa
