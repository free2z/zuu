#!/usr/bin/env python3
"""Generate the committed CLDR language names used by the Free2Z application.

Install py/free2z/requirements/language-data.txt with --require-hashes and
--only-binary=:all: in a separate developer environment. These data packages
are not backend runtime dependencies.
Run scripts/free2z/gen-language-names.py when the curated language sets change;
the backend language-registry tests verify their coverage.
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PY_ROOT = REPO_ROOT / "py" / "free2z"
OUTPUT = PY_ROOT / "f2z" / "language_names.py"

sys.path.insert(0, str(PY_ROOT))

HEADER = '''\
"""CLDR display names for the curated language sets. GENERATED — DO NOT EDIT.

Regenerate with ``scripts/free2z/gen-language-names.py`` after changing
``f2z.languages.TRANSLATABLE``, ``f2z.languages.UI_LOCALES`` or
``f2z.languages.ALSO_NAMED``. The generator
uses a separate developer environment so the CLDR database and its compiled
lookup dependency are not required at runtime.

CLDR data via langcodes {version} / language_data {data_version}.
"""

# Localized language names: {{viewer locale: {{language tag: name}}}}.
#
# Covers TRANSLATABLE + UI_LOCALES + ALSO_NAMED. The last of those is the set
# of tags we accept but do not sell and still refuse to name out of the IANA
# registry, which speaks English only -- see ALSO_NAMED in f2z/languages.py.
CLDR_DISPLAY_NAMES = {{
{names}}}

# Each language's name written in that language itself (its endonym). One
# entry per language we actually OFFER -- TRANSLATABLE + UI_LOCALES, not
# ALSO_NAMED -- independent of the viewer's locale.
AUTONYMS = {{
{autonyms}}}
'''


def main():
    from importlib.metadata import version as dist_version

    try:
        from langcodes import Language

        import language_data  # noqa: F401  (import is the availability check)
    except ModuleNotFoundError as exc:  # pragma: no cover - developer tool
        sys.exit(
            f"{exc}\n\nThis generator needs the CLDR name database:\n"
            "    pip install --require-hashes --only-binary=:all: -r py/free2z/requirements/language-data.txt\n"
            "It is deliberately NOT in py/free2z/requirements/main.txt."
        )

    expected = {"langcodes": "3.5.1", "language_data": "1.4.0", "marisa-trie": "1.4.1"}
    for name, version in expected.items():
        if dist_version(name) != version:
            sys.exit(f"{name} must be {version} to reproduce the committed language data")

    from f2z.languages import ALSO_NAMED, TRANSLATABLE, UI_LOCALES

    # Autonyms are for languages we offer; display names also cover the tags we
    # merely accept, so the IANA composer stays unreachable in practice.
    offered = sorted(set(TRANSLATABLE) | set(UI_LOCALES))
    tags = sorted(set(offered) | set(ALSO_NAMED))

    name_blocks = []
    for viewer in UI_LOCALES:
        rows = "".join(
            f"        {tag!r}: {Language.get(tag).display_name(viewer)!r},\n"
            for tag in tags
        )
        name_blocks.append(f"    {viewer!r}: {{\n{rows}    }},\n")

    autonyms = "".join(
        f"    {tag!r}: {Language.get(tag).autonym()!r},\n" for tag in offered
    )

    OUTPUT.write_text(
        HEADER.format(
            version=dist_version("langcodes"),
            data_version=dist_version("language_data"),
            names="".join(name_blocks),
            autonyms=autonyms,
        ),
        encoding="utf-8",
    )
    print(f"wrote {OUTPUT} ({len(tags)} languages x {len(UI_LOCALES)} locales)")


if __name__ == "__main__":
    main()
