from django.apps import AppConfig


class IdentityConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "dj.apps.identity"
    label = "identity"
    verbose_name = "Identity"

    def ready(self):
        from django.contrib.auth.signals import user_logged_out

        from .auth_context import forget_on_logout

        # A logout forgets its credential's AuthContext. Every
        # logout here sends this signal: Django's `logout()` (the session
        # routes) and knox's two logout views.
        user_logged_out.connect(
            forget_on_logout, dispatch_uid="identity.forget_auth_context",
        )
