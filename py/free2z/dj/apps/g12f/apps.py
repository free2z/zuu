from django.apps import AppConfig
from django.core.checks import register


class G12FConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'dj.apps.g12f'

    def ready(self):
        from . import signals  # noqa: F401

        # Project-wide, not g12f-specific: g12f is simply the app every
        # process loads. timestamptz reads must not depend on the session
        # TimeZone that PgBouncer transaction pooling would own.
        from django.db.backends.signals import connection_created

        from dj.util.db_timezone import install_converting_tz_loader

        connection_created.connect(
            install_converting_tz_loader,
            dispatch_uid="dj.util.db_timezone.install_converting_tz_loader",
        )

        # Procrastinate autodiscovers `<app>.tasks` only, so a task defined in
        # a sub-package is invisible to the worker unless something imports it.
        # Importing it here rather than from `g12f/tasks.py` keeps the paid
        # translation work in its own module tree ( P8) instead of growing
        # a file three other agents are editing.
        from .translation import tasks as translation_tasks  # noqa: F401

        # "Read variants, do not write them" is unreachable because
        # dual_write_enabled() ignores the kill switch while reads are on --
        # and an ignored operational switch must never be an ignored SILENT
        # switch. `manage.py check` (CI, and every management command the
        # deploy runs) reports it; the pod-runtime half is the WARNING in
        # variants._warn_dual_write_is_ignored ( M6, ).
        from .checks import check_zpage_variant_flags

        register(check_zpage_variant_flags)
