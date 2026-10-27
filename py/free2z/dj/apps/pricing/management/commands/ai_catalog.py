"""Print the signed AI catalogue, or the catalogue key's public half.

    manage.py ai_catalog                 # the body GET /api/ai/catalog/v1 serves now
    manage.py ai_catalog --now 1790001234
    manage.py ai_catalog --public-key    # key_id + public key hex, for the
                                         # gateway's trusted-key configuration

Read-only: builds and signs in memory, writes nothing. Exits non-zero with the
refusal reason when the endpoint would refuse, so it doubles as a pre-flight
check after provisioning the key or publishing a rate card. It is NOT a
re-signer -- the endpoint signs on every request (see
``dj.apps.pricing.catalog``), so there is nothing to schedule.
"""
from django.core.management.base import BaseCommand, CommandError

from dj.apps.pricing import catalog


class Command(BaseCommand):
    help = "Print the signed AI catalogue (or --public-key). Read-only."

    def add_arguments(self, parser):
        parser.add_argument(
            "--public-key", action="store_true",
            help="Print the configured key id and Ed25519 public key (hex) only.")
        parser.add_argument(
            "--now", type=int, default=None,
            help="Unix seconds to sign at (default: now).")

    def handle(self, *args, **options):
        try:
            if options["public_key"]:
                key = catalog.load_signing_key()
                self.stdout.write(f"{key.key_id} {key.public_key_hex}")
                return
            now = options["now"] if options["now"] is not None else catalog.now_unix()
            signed = catalog.signed_catalog(now)
        except catalog.CatalogRefused as exc:
            raise CommandError(f"refused: {exc.reason}: {exc.detail}") from None
        self.stdout.write(signed.body.decode("utf-8"))
