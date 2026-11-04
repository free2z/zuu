from django.apps import AppConfig
from django.conf import settings


class HandlesConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "dj.apps.handles"
    verbose_name = "Messaging handles"

    def ready(self):
        from django.db.models.signals import post_save, pre_delete

        from . import signals

        post_save.connect(
            signals.reserve_on_create,
            sender=settings.AUTH_USER_MODEL,
            dispatch_uid="handles.reserve_on_create",
        )
        pre_delete.connect(
            signals.retire_on_delete,
            sender=settings.AUTH_USER_MODEL,
            dispatch_uid="handles.retire_on_delete",
        )
