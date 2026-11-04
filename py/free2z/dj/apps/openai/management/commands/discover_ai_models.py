"""Record what every keyed AI provider says it serves (``dj.apps.openai.discovery``).

    manage.py discover_ai_models                 # every configured provider
    manage.py discover_ai_models --provider openai
    manage.py discover_ai_models --report        # read-only: print the last snapshot

Runs from the ``discover-ai-models`` CronJob (``k8s/free2z/cron/BUILD.bazel``).
One bounded listing call per configured provider; the answer is upserted into
``ProviderModel`` and the signed catalogue / chat picker gate on it
(``AIModelQuerySet.discovered``). A provider whose listing fails is left at its
last successful snapshot and makes the command exit 1, so the existing Job
failure alerting is the signal; a provider with no key is skipped, exit 0.

Discovered ids with no ``AIModel`` row are the "please price me" report: one
``ai_models_discovered_unpriced`` line per provider, and ``--report`` prints
them. Nothing here creates, prices or enables a model.
"""
from django.core.management.base import BaseCommand, CommandError

from dj.apps.openai import discovery
from dj.apps.openai.models import AIModel, ProviderModel
from f2z.ai.providers import API_KEY_NAMES


class Command(BaseCommand):
    help = "List each keyed provider's models and record availability (see module docstring)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--provider", action="append", choices=sorted(API_KEY_NAMES),
            help="Only this provider (repeatable). Default: every configured one.")
        parser.add_argument(
            "--report", action="store_true",
            help="Print the recorded snapshot and the unpriced ids; no provider call.")

    def handle(self, *args, **options):
        if options["report"]:
            self._report()
            return
        report = discovery.discover(options["provider"])
        for provider, why in sorted(report.skipped.items()):
            self.stdout.write(f"skipped {provider}: {why}")
        for result in report.results:
            self.stdout.write(
                f"{result.provider}: {len(result.listed)} listed, "
                f"{len(result.added)} new, {len(result.returned)} back, "
                f"{len(result.gone)} gone, {len(result.unpriced)} unpriced")
            for model_id in result.unpriced:
                self.stdout.write(f"  unpriced: {result.provider}/{model_id}")
        if report.failed:
            raise CommandError(
                "discovery failed for: " + ", ".join(report.failed)
                + " (nothing written for them; see the ai_model_discovery_failed log line)")

    def _report(self):
        priced = {
            (row.provider, row.upstream_model_id)
            for row in AIModel.objects.only("provider", "model", "provider_model_id")
        }
        rows = list(ProviderModel.objects.order_by("provider", "provider_model_id"))
        if not rows:
            self.stdout.write("no discovery snapshot recorded yet")
            return
        for row in rows:
            state = f"missing since {row.missing_since:%Y-%m-%d %H:%M}Z" if row.missing_since else "listed"
            tag = "priced" if (row.provider, row.provider_model_id) in priced else "UNPRICED"
            self.stdout.write(
                f"{row.provider}/{row.provider_model_id}: {state}, {tag}, "
                f"last seen {row.last_seen_at:%Y-%m-%d %H:%M}Z")
