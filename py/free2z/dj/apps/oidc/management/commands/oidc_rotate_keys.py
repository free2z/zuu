"""``manage.py oidc_rotate_keys``: mint a new signing key, print the PEM.

Rotation (spec §6.1) is: generate a new key, publish it FIRST in the JWKS
while the previous key stays published for at least 24 hours, sign with the
new one, then drop the old one. Keys live in Secret Manager and reach pods
as the ``OIDC_ES256_PRIVATE_KEYS`` / ``OIDC_RS256_PRIVATE_KEYS`` environment
variables, which hold concatenated PEM blocks, active first. So the command
prints the new block and the operator prepends it; it writes nothing.

    manage.py oidc_rotate_keys --alg es256      # one new ES256 block
    manage.py oidc_rotate_keys --alg all        # both algorithms
    manage.py oidc_rotate_keys --show-jwks      # the JWKS this config publishes
"""
from __future__ import annotations

import json

from django.core.management.base import BaseCommand, CommandError

from dj.apps.oidc import keys


class Command(BaseCommand):
    help = "Generate a new OIDC signing key (prints the PEM; writes nothing)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--alg", choices=["es256", "rs256", "all"], default=None,
            help="Which key to generate.",
        )
        parser.add_argument(
            "--show-jwks", action="store_true",
            help="Print the public JWKS the current settings would publish.",
        )

    def handle(self, *args, **options):
        if not options["alg"] and not options["show_jwks"]:
            raise CommandError("nothing to do: pass --alg es256|rs256|all and/or --show-jwks")
        if options["alg"]:
            algs = {
                "es256": [keys.ALG_ES256],
                "rs256": [keys.ALG_RS256],
                "all": [keys.ALG_ES256, keys.ALG_RS256],
            }[options["alg"]]
            for alg in algs:
                private = keys.generate_private_key(alg)
                signing_key = keys.signing_key_from_private(alg, private)
                self.stderr.write(
                    f"# New {alg} key, kid={signing_key.kid}. Prepend this block to "
                    f"{keys.ENV_VARS[alg]} (Secret Manager); keep the previous "
                    "block(s) after it for at least 24 hours, then drop them.\n"
                )
                self.stdout.write(keys.private_key_to_pem(private))
        if options["show_jwks"]:
            try:
                ring = keys.load_keyring()
            except keys.SigningKeysUnavailable as exc:
                raise CommandError(str(exc)) from None
            if ring.generated:
                self.stderr.write("# WARNING: these keys were GENERATED for this process; "
                                  "no deployment publishes them.\n")
            self.stdout.write(json.dumps(ring.public_jwks(), indent=2))
