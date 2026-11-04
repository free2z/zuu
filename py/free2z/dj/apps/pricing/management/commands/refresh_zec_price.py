"""
Poll the exchanges and store a fresh ZEC/USD price snapshot.

Run frequently (every minute) by a k8s CronJob so the live 2Z<->ZEC rate the
UIs display and the crediting job uses stays current.
"""
from django.core.management.base import BaseCommand

from dj.apps.pricing.service import refresh_snapshot, PricingUnavailable


class Command(BaseCommand):
    help = "Fetch ZEC/USD from exchanges and store a ZecPriceSnapshot."

    def handle(self, *args, **options):
        try:
            snapshot = refresh_snapshot()
        except PricingUnavailable as exc:
            # A transient inability to fetch a fresh price is expected (flaky
            # exchanges). Exit 0 so the once-a-minute CronJob doesn't
            # CrashLoop/retry-storm under concurrencyPolicy: Forbid — the last
            # good snapshot keeps being served until the next run succeeds.
            self.stderr.write(self.style.WARNING(
                f"pricing refresh skipped (kept last good price): {exc}"))
            return

        self.stdout.write(self.style.SUCCESS(
            f"ZEC=${snapshot.zec_usd} (median ${snapshot.median_usd}) "
            f"from {snapshot.num_sources} sources -> "
            f"{snapshot.tuzis_per_zec} 2Z/ZEC"
        ))
        if snapshot.rejected:
            self.stdout.write(f"rejected outliers: {snapshot.rejected}")
