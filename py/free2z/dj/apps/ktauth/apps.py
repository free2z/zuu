from django.apps import AppConfig


class KtauthConfig(AppConfig):
    """The handle-ownership authority. **No models, no migrations.**

    Still true after: the durable ``account_epoch`` counter is a column on
    ``g12f.Creator``, because it counts account-ownership events and those
    belong to the account, not to key transparency. ``epoch.py`` reads and
    writes it; this app owns no table.

    This app is in ``INSTALLED_APPS`` for exactly one reason: ``ready()`` is
    the boot hook, and the issuing key is fetched at boot so that a request
    never pays for a Secret Manager round trip and a missing secret is visible
    in the startup log rather than on the first enrollment.

    ``ready()`` cannot raise. A key that will not load must degrade to a 503 on
    one endpoint, not to a pod that will not start.
    """

    default_auto_field = 'django.db.models.BigAutoField'
    name = 'dj.apps.ktauth'
    label = 'ktauth'
    verbose_name = 'Key-transparency handle authority'

    def ready(self):
        from django.db.models.signals import post_save

        from . import signing
        from .credentials import receive_auth_token_saved

        signing.prime()

        # Every Knox token carries the account epoch it was minted against, so
        # that authentication can refuse one the account has outlived.
        # Wired to the model rather than to the two login views this repo owns
        # because knox mints tokens too (`/api/token/login/`), and a token with
        # no stamp is refused -- see `dj.apps.ktauth.authentication`. Sending a
        # string sender avoids importing knox's models before the registry is
        # populated.
        post_save.connect(
            receive_auth_token_saved,
            sender="knox.AuthToken",
            dispatch_uid="ktauth.stamp_issued_token",
        )
