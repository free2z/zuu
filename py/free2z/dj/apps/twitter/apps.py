from django.apps import AppConfig


class TwitterConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'dj.apps.twitter'

    def ready(self):
        # @F2ZP2P first-publication announcements. A receiver, not a
        # direct call from g12f, so the page model does not import this app.
        from dj.apps.g12f.publication import zpage_first_published

        from .announcements import on_zpage_first_published

        zpage_first_published.connect(
            on_zpage_first_published,
            dispatch_uid="twitter.f2zp2p.zpage_first_published",
        )
