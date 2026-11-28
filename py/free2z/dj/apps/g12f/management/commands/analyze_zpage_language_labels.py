"""Bounded, read-only heuristic inventory of public detected language labels."""
from collections import Counter
import re
import unicodedata

from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction
from django.db.models.functions import Greatest, Length, Substr
from langcodes import Language

from dj.apps.g12f.models.zpage import (
    LANGUAGE_DETECTION_PATH_BATCH, LANGUAGE_DETECTION_PATH_LIVE,
    LANGUAGE_SOURCE_DETECTED, PUBLICLY_VISIBLE, zPage,
)
from f2z.languages import is_detectable, normalize

MAX_PAGES = 100_000
MAX_BATCH_SIZE = 500
MAX_SAMPLE_CHARS = 4000
WINDOWS = 3
LANGUAGE_MARKERS = {
    "en": {"the", "and", "with", "this", "from"},
    "es": {"el", "los", "para", "con", "una"},
    "fr": {"les", "des", "avec", "pour", "une"},
    "pt": {"uma", "para", "com", "não", "que"},
}


def script_mismatch(label, sample):
    """True/False for Latin/Cyrillic only; None when evidence is inapplicable."""
    try:
        expected = Language.get(label).script
    except (ValueError, LookupError):
        return None
    if expected not in {"Latn", "Cyrl"}:
        return None
    observed = Counter()
    for char in sample:
        name = unicodedata.name(char, "")
        if "CYRILLIC" in name:
            observed["Cyrl"] += 1
        elif "LATIN" in name:
            observed["Latn"] += 1
    other = "Latn" if expected == "Cyrl" else "Cyrl"
    return observed[other] > observed[expected] and observed[other] >= 20


def language_mismatch(label, sample):
    """Small lexical marker comparison; heuristic, never ground truth."""
    stored = label.split("-", 1)[0].lower()
    words = set(re.findall(r"[^\W\d_]+", sample.casefold(), re.UNICODE))
    scores = {language: len(words & markers)
              for language, markers in LANGUAGE_MARKERS.items()}
    other = max((score for language, score in scores.items()
                 if language != stored), default=0)
    return other >= 2 and other > scores.get(stored, 0)


class Command(BaseCommand):
    help = "Plan or run a bounded read-only aggregate language-label heuristic scan."

    def add_arguments(self, parser):
        parser.add_argument("--scan", action="store_true")
        parser.add_argument("--max-pages", type=int, default=1000)
        parser.add_argument("--batch-size", type=int, default=200)
        parser.add_argument("--sample-chars", type=int, default=1000)

    def handle(self, *args, **opts):
        maximum, batch, chars = (opts["max_pages"], opts["batch_size"],
                                 opts["sample_chars"])
        if not 1 <= maximum <= MAX_PAGES:
            raise CommandError(f"--max-pages must be 1..{MAX_PAGES}")
        if not 1 <= batch <= MAX_BATCH_SIZE:
            raise CommandError(f"--batch-size must be 1..{MAX_BATCH_SIZE}")
        if not 3 <= chars <= MAX_SAMPLE_CHARS:
            raise CommandError(f"--sample-chars must be 3..{MAX_SAMPLE_CHARS}")
        self.stdout.write(
            f"Read-only plan: max_pages={maximum}, batch_size={batch}, "
            f"sample_chars={chars}; no provider calls or writes."
        )
        if not opts["scan"]:
            self.stdout.write("Add --scan to read public eligible pages.")
            return
        base = zPage.objects.filter(
            PUBLICLY_VISIBLE, is_subscriber_only=False,
            language_source=LANGUAGE_SOURCE_DETECTED,
        ).exclude(source_language__isnull=True).exclude(source_language="")
        snapshot_max = base.order_by("-pk").values_list("pk", flat=True).first()
        if snapshot_max is None:
            self.stdout.write("scanned=0 truncated=false")
            return
        title_width = chars // 4
        width = (chars - title_width) // WINDOWS
        widths = (width + (chars - title_width) % WINDOWS, width, width)
        base = base.annotate(
            _title=Substr("title", 1, title_width),
            _start=Substr("content", 1, widths[0]),
            _middle=Substr("content", 50000, widths[1]),
            _end=Substr(
                "content", Greatest(Length("content") - widths[2] + 1, 1),
                widths[2],
            ),
        )
        counts, labels = Counter(), Counter()
        last_pk, scanned, truncated = 0, 0, False
        while scanned < maximum:
            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute("SET LOCAL statement_timeout = '5s'")
                rows = list(base.filter(pk__gt=last_pk, pk__lte=snapshot_max)
                    .order_by("pk").values_list(
                        "pk", "source_language", "language_detection_path",
                        "_title", "_start", "_middle", "_end",
                    )[:min(batch, maximum - scanned)])
            if not rows:
                break
            for pk, label, path, title, start, middle, end in rows:
                last_pk, scanned = pk, scanned + 1
                path = path if path in (LANGUAGE_DETECTION_PATH_LIVE,
                                        LANGUAGE_DETECTION_PATH_BATCH) else "legacy_unknown"
                counts[(path, "scanned")] += 1
                try:
                    canonical = normalize(label, allow_missing=False)
                except (ValueError, TypeError):
                    canonical = None
                if not canonical or not is_detectable(canonical):
                    counts[(path, "invalid_or_unknown_language")] += 1
                    continue
                primary = canonical.split("-", 1)[0]
                if not primary.isalpha() or len(primary) > 8:
                    counts[(path, "invalid_or_unknown_language")] += 1
                    continue
                labels[(path, primary)] += 1
                sample = "\n".join((title or "", start or "", middle or "", end or ""))
                if script_mismatch(canonical, sample):
                    counts[(path, "script_mismatch_heuristic")] += 1
                if language_mismatch(canonical, sample):
                    counts[(path, "language_mismatch_heuristic")] += 1
            if scanned == maximum:
                truncated = base.filter(pk__gt=last_pk, pk__lte=snapshot_max).exists()
        self.stdout.write(
            f"scanned={scanned} truncated={str(truncated).lower()} "
            "sample_windows=start,middle,end; heuristic, not ground truth"
        )
        for (path, bucket), count in sorted(counts.items()):
            self.stdout.write(f"path={path} {bucket}={count}")
        for (path, language), count in sorted(labels.items()):
            self.stdout.write(f"path={path} stored_primary={language} count={count}")
