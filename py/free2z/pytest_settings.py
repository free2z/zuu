"""Django settings used only by the backend pytest suite (`py/pytest.ini`).

The application uses the production-cost password hasher in ``settings.py``
and ``prod_settings.py``. Test factories create many accounts whose passwords
are only fixtures, and paying the production KDF for each one dominates setup.
``FastPBKDF2Hasher`` below drops the work factor to a single iteration while
keeping everything else about the hasher identical.

WHY NOT ``MD5PasswordHasher``, the obvious fast choice: the encoded value's
ALGORITHM PREFIX is load-bearing in this codebase.
``dj/apps/g12f/models/zpage.py`` re-hashes on save unless the stored value
already starts with ``pbkdf2_sha256``:

    if not self.password.startswith("pbkdf2_sha256"):
        self.password = make_password(self.password)

Under an ``md5$`` prefix that guard never matches, so every subsequent
``zPage.save()`` hashes the already-hashed value again and the page password
silently stops verifying — behaviour that exists only in CI. A test suite that
runs a password path under semantics production never uses can neither catch a
regression there nor be trusted when it reports one. One iteration of PBKDF2
costs about the same as MD5 and keeps the prefix, so the speed-up is kept and
the divergence is not. (Found by the codex adversarial review of.)

``dj/apps/g12f/test_password_change_reauth.py`` covers the real thing from
both ends: ``test_production_password_hasher_persists_and_authenticates``
loads the actual ``prod_settings`` hasher list and drives a persisted password
plus a session login through it, and the PBKDF2 upgrade regression installs
its own ``PASSWORD_HASHERS`` override. Those two are the only places the
production work factor is exercised, so do not delete them alongside this
speed-up.

THIS MODULE LIVES AT ``py/`` ON PURPOSE, not under ``py/dj/``. The deployed web
image packages ``dj/**/*.py`` (the ``djfiles`` filegroup in ``py/BUILD.bazel``),
so a settings module here that weakens password hashing would ship inside the
production container. Nothing there selects it today, but / is this
repo's guard for exactly the "what is actually in the image" class of mistake,
and a one-iteration hasher is one ``DJANGO_SETTINGS_MODULE`` typo from being
real. ``dj/apps/test_deployed_settings.py`` pins the location.
"""

from django.contrib.auth.hashers import PBKDF2PasswordHasher

from dj.free2z.settings import *  # noqa: F403


class FastPBKDF2Hasher(PBKDF2PasswordHasher):
    """Production's algorithm, encoding and prefix; a fixture's work factor.

    NEVER reachable from production: `prod_settings.PASSWORD_HASHERS` does not
    name it, and this module is excluded from the deployed image.
    """

    iterations = 1


PASSWORD_HASHERS = ["pytest_settings.FastPBKDF2Hasher"]

# Signed AI catalogue: the PUBLIC RFC 8032 section 7.1 TEST 1 key, the
# one zuu's f2z-ai-proto catalogue fixtures are signed with. Never a production
# key -- dj.apps.pricing.catalog refuses it unless this flag is on.
AI_CATALOG_SIGNING_KEY = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
AI_CATALOG_KEY_ID = "fixture-rfc8032-test1"
AI_CATALOG_ALLOW_TEST_KEY = True
