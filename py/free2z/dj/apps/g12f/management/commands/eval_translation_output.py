"""Manually evaluate a synthetic translation sample; never part of CI."""
import decimal
import json
import os
from pathlib import Path
import tempfile

from django.core.management.base import BaseCommand, CommandError
from f2z import languages
from dj.apps.g12f.translation import management_eval
from dj.apps.g12f.translation.service import select_translation_model


class Command(BaseCommand):
    help = "Price or manually record a bounded translation output evaluation."

    def add_arguments(self, parser):
        parser.add_argument("--language", action="append", help="Target code; repeatable. Default: all TRANSLATABLE languages.")
        parser.add_argument("--execute", action="store_true", help="Explicitly permit paid provider calls.")
        parser.add_argument("--max-provider-usd", type=decimal.Decimal, help="Required finite hard provider-cost ceiling with --execute.")
        parser.add_argument("--output", default="translation-eval-record.json")

    def handle(self, *args, **opts):
        try:
            selected = management_eval.validate_languages(
                opts["language"] or sorted(languages.TRANSLATABLE)
            )
        except ValueError as exc:
            raise CommandError(str(exc)) from exc
        model = select_translation_model()
        if model is None:
            raise CommandError("no callable translation model is configured")
        target = Path(opts["output"])
        if opts["execute"]:
            cap = opts["max_provider_usd"]
            if cap is None or not cap.is_finite() or cap <= 0:
                raise CommandError("--execute requires finite positive --max-provider-usd")
            if target.exists():
                raise CommandError(f"refusing to overwrite existing recording: {target}")
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open("x", encoding="utf-8") as handle:
                    json.dump({"schema": "free2z.translation-eval.v1", "status": "starting"}, handle)
                    handle.write("\n")
            except OSError as exc:
                raise CommandError(f"cannot reserve output artifact before spending: {exc}") from exc

        def checkpoint(record):
            if not opts["execute"]:
                return
            fd, temp_name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump(record, handle, ensure_ascii=False, indent=2)
                    handle.write("\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temp_name, target)
            finally:
                if os.path.exists(temp_name):
                    os.unlink(temp_name)

        try:
            report = management_eval.run(
                model=model, languages_to_run=selected, call_provider=opts["execute"],
                spend_cap=opts["max_provider_usd"], on_record=checkpoint,
                on_estimate=lambda amount: self.stdout.write(
                    f"Creator quote estimate: {amount} 2Z; provider calls: {opts['execute']}"
                ),
            )
        except (ValueError, OSError) as exc:
            raise CommandError(str(exc)) from exc
        if opts["execute"]:
            checkpoint(report)
            self.stdout.write(f"Recording checkpoint: {target}")
        else:
            self.stdout.write("No provider calls made. Add --execute and --max-provider-usd to record a run.")
