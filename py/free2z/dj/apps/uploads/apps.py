from django.apps import AppConfig


class UploadsConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'dj.apps.uploads'

    def ready(self):
        from . import signals  # noqa: F401

        # Belt and braces for. dj/free2z/settings.py already called this
        # at settings-import time, which is what actually guarantees the
        # ordering. Re-apply here because mimetypes.init() REBUILDS the
        # process-wide table from scratch and silently discards every
        # add_type() that came before it; any third-party module that calls it
        # while apps are importing would otherwise take.webp/.m4a back to
        # application/octet-stream with no test noticing. Idempotent, and
        # ready() still runs long before the first request or upload.
        from dj.util.mimetypes_registry import register_mime_types
        register_mime_types()
