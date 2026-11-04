from django.apps import AppConfig


class OidcConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "dj.apps.oidc"
    label = "oidc"
    verbose_name = "OIDC identity provider"

    def ready(self):
        # The system check that turns "no signing key in production" into a
        # red `manage.py check` (which `migrate` runs, which the deploy waits
        # on) rather than into tokens nobody can verify. Import for the
        # registration side effect.
        from . import checks, ledger_signals  # noqa: F401
        from .cors import connect as connect_cors

        # Registered public web clients may complete the flow with fetch()
        # alone (spec §3.1): their origins are allowed on the OAuth endpoints.
        connect_cors()
