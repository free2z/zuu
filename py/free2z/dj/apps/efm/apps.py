from django.apps import AppConfig


class EfmConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'dj.apps.efm'

    def ready(self):
        # DELIBERATELY EMPTY while the app is OFFLINE (see __init__.py).
        #
        # This used to register `checks.check_webauthn_relying_party` as a
        # `Tags.security` system check, and to evaluate the same rules here so
        # gunicorn/daphne -- which load the app WITHOUT running system checks
        # -- still logged a bad relying party at pod start.
        #
        # Both are now wrong, and in opposite directions. The check emits
        # `Error`s, which make `manage.py check` (CI, and every management
        # command the deploy runs) fail hard. WEBAUTHN_RP_ID /
        # WEBAUTHN_EXPECTED_ORIGINS now guard nothing: no route reaches
        # `views.py`, so no passkey can be registered or verified. Keeping the
        # check registered would mean that tidying away dead settings breaks
        # the deploy of every unrelated app on the platform -- a landmine, not
        # a safeguard. The startup log would likewise be noise about a feature
        # nobody can reach.
        #
        # `checks.py` itself is unchanged and still directly tested. If this
        # app is ever routed again, restore both halves here in the same
        # commit that adds the route -- the config becomes security-critical
        # again the moment a request can reach it.
        pass
