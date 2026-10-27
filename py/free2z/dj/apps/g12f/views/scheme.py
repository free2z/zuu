from django.utils.translation import gettext_lazy as _
from drf_spectacular.contrib.knox_auth_token import (
    KnoxTokenScheme as ContribKnoxTokenScheme,
)
from drf_spectacular.extensions import OpenApiAuthenticationExtension


class KnoxTokenScheme(OpenApiAuthenticationExtension):
    """Kept as-is, and deliberately NOT given ``match_subclasses``.

    drf-spectacular ships its own extension for
    ``knox.auth.TokenAuthentication`` under the name ``knoxApiToken``, and that
    is the one the committed ``f2z.yaml`` publishes -- this one has been
    shadowed by it. Making this class match subclasses would have flipped every
    ``security:`` entry in the spec from ``knoxApiToken`` to ``tokenAuth``: 370
    lines of churn and a renamed security scheme in every generated client, for
    a change that alters nothing a client does.
    """

    target_class = 'knox.auth.TokenAuthentication'
    name = 'tokenAuth'

    def get_security_definition(self, auto_schema):
        return {
            'type': 'apiKey',
            'in': 'header',
            'name': 'Authorization',
            'description': _(
                'Token-based authentication with required prefix "%s"'
            ) % "Token"
        }


class AccountEpochKnoxTokenScheme(ContribKnoxTokenScheme):
    """The same published scheme, for the project's own Knox authenticator.

    ``AccountEpochTokenAuthentication``  is knox's authenticator plus a
    use-time account-epoch check. On the wire it is byte-for-byte the same
    credential -- ``Authorization: Token <key>`` -- so the published contract
    must not change, and a generated client must not see a renamed security
    scheme because the server grew a revocation check.

    Inheriting drf-spectacular's contrib extension rather than restating its
    definition is what guarantees that: the bytes come from the same builder,
    so the two cannot drift apart in a future drf-spectacular bump.
    ``dj/apps/test_authentication_inventory.py`` pins that ``f2z.yaml`` still
    advertises exactly the schemes the runtime accepts.
    """

    target_class = (
        'dj.apps.ktauth.authentication.AccountEpochTokenAuthentication'
    )
    name = 'knoxApiToken'
