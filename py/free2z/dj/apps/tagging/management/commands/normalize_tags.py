"""Deterministic tag normalization: the free, auditable first pass.

    python manage.py normalize_tags                # aliases only (default)
    python manage.py normalize_tags --dry-run      # plan only, no effects
    python manage.py normalize_tags --consolidate  # also move memberships

What it does
------------
Groups every ``taggit.Tag`` by:func:`dj.apps.tagging.models.tag_key` --
casefold plus whitespace identity, nothing more. AI synonymy (`zec` vs
`zcash`) is explicitly out of scope for this pass ( follow-up); what it
merges are spellings that differ only by case or whitespace, where "these are
the same tag" is arithmetic, not opinion.

Within each multi-member group it elects a canonical: **highest total
membership across BOTH through tables** (``taggit.TaggedItem`` for int-PK
content and ``comments.UUIDTaggedItem`` for comments), tie-broken by lowest
pk so the oldest spelling wins and repeated runs on a quiet corpus elect the
same tag every time.

Default mode is NON-destructive and free: for each variant it writes one
``TagAlias`` row (``get_or_create``, so re-runs are idempotent) and leaves
every ``Tag`` row and every membership untouched. A reader that resolves
aliases -- the ``?tags=`` filter and autocomplete narrowing -- finds the
canonical through its alias; nothing else changes. A variant whose name_key
already maps to a DIFFERENT canonical is recorded as a conflict in the plan
and skipped loudly, never silently remapped.

``--dry-run`` computes and prints the whole plan -- groups, counts, canonical
choice, which aliases would be created, which conflict -- and creates NO
aliases and moves NO memberships. It DOES write a ``TagNormalizationRun`` row
with ``dry_run=True``, deliberately: runs must stay visible even when they did
nothing, or "ran and found nothing" becomes indistinguishable from "never
ran".

``--consolidate`` is opt-in destructive-but-reversible: per group, inside its
own transaction, every object carrying a variant gains the canonical tag and
loses the variant -- across both through tables -- and the variant ``Tag``
row is deleted ONLY once zero rows reference it in either table. Every move
is counted into the run's ``plan`` JSON. This mirrors what
``openai.models.combine_tags`` did, but transactional, chunked per group and
journaled: the old function moved rows in autocommit mode with no record, so
a crash mid-tag silently split a merge in two.

Reversibility
-------------
A consolidation decision is reversed by deleting that run's alias rows and
replaying its ``plan`` backwards: the plan records each variant's original
``tag_id`` and every ``(content_type_id, object_id, created)`` triple moved
off it. The third element distinguishes canonical memberships this run ADDED
(``created=True``) from ones the object already carried (``False``): a replay
removes only the former, so an object that legitimately held both spellings
before the merge does not come back double-tagged.

Casefolding note: consolidation inherits the suggestion-key's casefold, so
e.g. ``STRASSE`` and ``strasse`` key together (while Turkish dotted/dotless
I deliberately do not) -- merging them is intended, not a bug.

Deployment
----------
Intended to run as a periodic k8s CronJob batch OFF the write path --
registering that CronJob is a deliberate follow-up, because Cloud Build YAML
cannot be validated offline (see "Known Cloud Build validation gap" in
AGENTS.md), and an unvalidatable manifest must not ride along with the code
that needs it.
"""

import uuid

from django.core.management.base import BaseCommand, CommandError
from django.db import models as db_models
from django.db import transaction
from django.utils import timezone
from taggit.models import Tag, TaggedItem

from dj.apps.tagging.models import (
    TagAlias,
    TagNormalizationRun,
    tag_key,
)

#Bound matching ``TagNormalizationRun.notes.max_length``; truncating beats
#failing an otherwise good run over a chatty operator note.
NOTES_MAX_LENGTH = 500


def journal_object_id(object_id):
    """``object_id`` as the run's ``plan`` JSON can store it.

    ``GenericUUIDTaggedItemBase.object_id`` hands back real ``uuid.UUID``
    instances, and a raw UUID raises ``TypeError: Object of type UUID is not
    JSON serializable`` the moment the plan is saved -- taking the whole
    consolidation pass down with it. Stringified it round-trips through every
    object_id lookup unchanged; int PKs pass through untouched so the journal
    stays byte-comparable across both through tables.
    """
    return str(object_id) if isinstance(object_id, uuid.UUID) else object_id


def uuid_tagged_item_model():
    """The comments app's UUID through table, imported lazily.

    ``comments.models`` imports ``g12f.models.creator`` (for ``Bannable``),
    which pulls half the dependency graph with it -- importing it at module
    scope here risks an import cycle depending on which app Django loads
    first. The command is the only caller, and it needs the model at call
    time.
    """
    from dj.apps.comments.models import UUIDTaggedItem

    return UUIDTaggedItem


def through_tables():
    """Every table a membership can live in, for counting and for moving."""
    yield TaggedItem
    yield uuid_tagged_item_model()


def membership_counts(tag_ids):
    """Total memberships per tag id, summed across both through tables."""
    counts = {}
    for through in through_tables():
        rows = (
            through.objects.filter(tag_id__in=tag_ids)
            .values("tag_id")
            .annotate(total=db_models.Count("id"))
        )
        for row in rows:
            counts[row["tag_id"]] = counts.get(row["tag_id"], 0) + row["total"]
    return counts


class Command(BaseCommand):
    help = (
        "Deterministically group case/whitespace variants of the same tag, "
        "record each canonical choice as TagAlias rows (#1209), and "
        "optionally --consolidate memberships onto the canonical tag. "
        "Non-destructive by default; every run is journaled to "
        "TagNormalizationRun. Meant for a periodic k8s CronJob off the write "
        "path (registration is a follow-up: Cloud Build YAML cannot be "
        "validated offline). --consolidate is reversible via the run's plan "
        "JSON plus its TagAlias rows."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Print the full plan and create NO aliases and move NO "
                 "memberships. A TagNormalizationRun(dry_run=True) audit row "
                 "IS written, on purpose, so no-op runs stay visible.",
        )
        parser.add_argument(
            "--consolidate",
            action="store_true",
            help="Additionally move memberships onto the canonical tag "
                 "(across BOTH through tables) and delete variant tags once "
                 "orphaned. Reversible via the run's plan JSON + alias rows.",
        )
        parser.add_argument(
            "--notes",
            default="",
            help="Free-text note stored on the TagNormalizationRun row.",
        )

    # -- grouping ---------------------------------------------------------- #

    def _build_groups(self, counts, tags):
        """Elect a canonical per multi-member key group.

        ``counts`` maps tag pk -> total membership. Highest count wins,
        lowest pk breaks ties (oldest spelling, stable across runs).
        """
        groups = {}
        for tag in tags:
            groups.setdefault(tag_key(tag.name), []).append(tag)

        elected = {}
        for key, members in groups.items():
            if len(members) < 2:
                continue
            members.sort(key=lambda t: (-counts.get(t.pk, 0), t.pk))
            elected[key] = {"canonical": members[0], "variants": members[1:]}
        # Sorted by key so the same corpus produces the same plan and the
        # same output order whatever the DB's row order happened to be.
        return dict(sorted(elected.items()))

    # -- aliasing ---------------------------------------------------------- #

    def _ensure_alias(self, variant_name, canonical):
        """Create the alias unless this source key already maps elsewhere.

        Returns ``(created, conflict)``: ``conflict`` is None on success, else
        the pre-existing alias whose canonical claims this name_key. The
        conflict check happens BEFORE any insert -- creating first and
        un-creating after would briefly publish exactly the second mapping we
        exist to refuse.
        """
        key = tag_key(variant_name)
        if not hasattr(self, "_aliases_by_source_key"):
            self._aliases_by_source_key = {}
            for alias in TagAlias.objects.only(
                "pk", "name", "name_key", "canonical_id"
            ).iterator(chunk_size=1000):
                self._aliases_by_source_key.setdefault(
                    tag_key(alias.name), []
                ).append(alias)

        existing = self._aliases_by_source_key.get(key, [])
        clash = next(
            (alias for alias in existing if alias.canonical_id != canonical.pk),
            None,
        )
        if clash is not None:
            return False, clash
        if existing:
            return False, None
        # Keyed on (name_key, canonical), NOT (name, canonical): one group can
        # hold several spellings that share a name_key ("Python" and "PYTHON"
        # both key to "python"), and a name-keyed lookup would miss the alias
        # already written for the first of them, attempt a second INSERT for
        # the same constraint pair, and die on uniq_tag_alias_per_canonical --
        # taking the whole pass with it.
        alias, created = TagAlias.objects.get_or_create(
            name_key=key,
            canonical=canonical,
            defaults={
                "name": variant_name,
                "source": TagAlias.DETERMINISTIC,
            },
        )
        if created:
            self._aliases_by_source_key.setdefault(key, []).append(alias)
        return created, None

    # -- consolidation ----------------------------------------------------- #

    def _move_memberships(self, variant, canonical):
        """Move every membership of ``variant`` onto ``canonical``.

        Returns ``(moved, triples, deleted)``: how many rows moved, their
        ``(content_type_id, object_id, created)`` triples for the journal,
        and whether the variant Tag was deleted afterwards. An object that
        already carried the canonical still counts as moved -- its variant
        row went away. ``created`` records whether THIS run added the
        canonical membership or it pre-existed; without it a plan replay
        cannot tell which canonical memberships to remove and would leave
        every replayed object double-tagged.
        """
        moved = 0
        triples = []
        for through in through_tables():
            rows = list(
                through.objects.filter(tag=variant).values_list(
                    "content_type_id", "object_id"
                )
            )
            for content_type_id, object_id in rows:
                # `get_or_create`, not blind create: the object may already
                # carry the canonical spelling alongside the variant. The
                # ``created`` flag is the journal's record of which is which.
                _, created = through.objects.get_or_create(
                    tag=canonical,
                    content_type_id=content_type_id,
                    object_id=object_id,
                )
                triples.append(
                    (content_type_id, journal_object_id(object_id), created)
                )
            through.objects.filter(tag=variant).delete()
            moved += len(rows)

        deleted = False
        # Under READ COMMITTED a concurrent tags.add() can insert a row for
        # the variant between the deletes above and this exists() re-check;
        # the variant then survives until the next pass -- acceptable for an
        # off-write-path cron batch.
        # Re-check BOTH tables before deleting. Deleting a tag another table
        # still references would CASCADE those memberships away with it --
        # data loss combine_tags avoided only by luck of iteration order.
        if not any(
            through.objects.filter(tag=variant).exists()
            for through in through_tables()
        ):
            variant.delete()
            deleted = True
        return moved, triples, deleted

    # -- the command ------------------------------------------------------- #

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        consolidate = options["consolidate"]

        if dry_run and consolidate:
            raise CommandError(
                "--dry-run and --consolidate are mutually exclusive: a dry "
                "run must never move anything, and refusing beats deciding "
                "which flag wins."
            )

        tags = list(Tag.objects.all().only("id", "name"))
        counts = membership_counts([tag.pk for tag in tags])
        groups = self._build_groups(counts, tags)

        plan = {}
        aliases_created = 0
        conflicts = 0
        items_moved = 0

        # The run row is written up front and finished at the end, so a pass
        # that dies mid-consolidation leaves a visible unfinished record --
        # not silence -- behind it.
        run = None

        if dry_run:
            for key, group in groups.items():
                plan[key] = self._plan_group(group, counts)
            self._print_plan(plan)
        else:
            with transaction.atomic():
                run = TagNormalizationRun.objects.create(
                    notes=options["notes"][:NOTES_MAX_LENGTH])
                for key, group in groups.items():
                    group_plan = self._plan_group(group, counts)
                    for entry in group_plan["variants"]:
                        created, conflict = self._ensure_alias(
                            entry["name"], group["canonical"])
                        entry["alias_created"] = created
                        if conflict is not None:
                            conflicts += 1
                            entry["conflict"] = {
                                "existing_alias_id": conflict.pk,
                                "existing_canonical_id":
                                    conflict.canonical_id,
                            }
                            self.stdout.write(self.style.WARNING(
                                f"CONFLICT: {entry['name']!r} already maps "
                                f"to canonical {conflict.canonical_id}; "
                                "skipping, never silently remapping."
                            ))
                        elif created:
                            aliases_created += 1

                    # Only now that entries carry their outcomes does the
                    # plan fragment become worth keeping.
                    plan[key] = group_plan

            if not consolidate:
                # An aliasing-only run moved nothing, so the journal must not
                # inherit the pre-pass membership snapshot under "items_moved"
                # -- that number is what a dry-run WOULD move, and only
                # --consolidate replaces it with what actually did.
                for group_plan in plan.values():
                    for entry in group_plan["variants"]:
                        entry["items_moved"] = 0

        if consolidate:
            # Per-group transactions, NOT one around the whole corpus: a
            # failure must roll back one merge, not re-open every alias it
            # already wrote.
            for key, group in groups.items():
                canonical = group["canonical"]
                with transaction.atomic():
                    for entry in plan[key]["variants"]:
                        if entry.get("conflict"):
                            # Consolidation must respect the same refusal the
                            # alias phase recorded: this variant's name_key
                            # maps to a DIFFERENT canonical, so moving its
                            # memberships here would silently overrule that
                            # decision.
                            entry["items_moved"] = 0
                            continue
                        variant = Tag.objects.filter(
                            pk=entry["tag_id"]).first()
                        if variant is None:
                            # Gone between the alias pass and here. Nothing
                            # was moved by THIS run, so the journal must not
                            # inherit the stale count from the snapshot.
                            entry["items_moved"] = 0
                            continue
                        moved, triples, deleted = self._move_memberships(
                            variant, canonical)
                        entry["items_moved"] = moved
                        entry["moved_pairs"] = [
                            list(triple) for triple in triples]
                        entry["deleted"] = deleted
                        items_moved += moved
                    # Journal incrementally, inside the same transaction as
                    # the moves it describes: a crash after this group's
                    # commit leaves its plan fragment -- and the marker that
                    # consolidation landed -- on the run row, not lost with
                    # the process.
                    run.plan[key] = plan[key]
                    run.consolidated = True
                    run.save(update_fields=["plan", "consolidated"])
                self.stdout.write(
                    f"consolidated '{key}' into "
                    f"'{canonical.name}' ({canonical.pk})"
                )

        if run is None:
            run = TagNormalizationRun.objects.create(
                notes=options["notes"][:NOTES_MAX_LENGTH],
                dry_run=True,
                finished_at=timezone.now(),
                plan=plan,
            )
        else:
            run.finished_at = timezone.now()
            # "plan" and "consolidated" are already persisted per group under
            # --consolidate; re-saving plan is redundant there but covers the
            # aliasing-only path, where nothing was saved since create().
            run.plan = plan
            run.save(update_fields=["finished_at", "plan"])

        self.stdout.write("")
        self.stdout.write(f"groups found:      {len(groups)}")
        self.stdout.write(f"aliases created:   {aliases_created}")
        self.stdout.write(f"conflicts skipped: {conflicts}")
        self.stdout.write(f"items moved:       {items_moved}")
        self.stdout.write(f"run id:            {run.pk}")

    # -- planning / printing ----------------------------------------------- #

    def _plan_group(self, group, counts):
        """One group's plan fragment, in the documented JSON shape."""
        canonical = group["canonical"]
        variants = []
        for variant in group["variants"]:
            variants.append({
                "name": variant.name,
                "tag_id": variant.pk,
                "items_moved": counts.get(variant.pk, 0),
                "alias_created": False,
                "conflict": None,
                "deleted": False,
            })
        return {
            "canonical_name": canonical.name,
            "canonical_id": canonical.pk,
            "counts": {
                "members": len(group["variants"]) + 1,
                "memberships": sum(
                    counts.get(t.pk, 0)
                    for t in [canonical] + group["variants"]
                ),
            },
            "variants": variants,
        }

    def _print_plan(self, plan):
        """Human-readable whole-plan dump; the JSON is the machine copy."""
        if not plan:
            self.stdout.write("No multi-spelling tag groups found.")
            return
        self.stdout.write(
            f"{len(plan)} group(s); the pass would elect the "
            "highest-membership spelling as canonical:"
        )
        for key, group in plan.items():
            self.stdout.write(
                f"  [{key}] canonical='{group['canonical_name']}' "
                f"(pk={group['canonical_id']}, "
                f"members={group['counts']['members']}, "
                f"memberships={group['counts']['memberships']})"
            )
            for entry in group["variants"]:
                self.stdout.write(
                    f"    variant '{entry['name']}' "
                    f"(pk={entry['tag_id']}, "
                    f"items={entry['items_moved']}) -> alias"
                )
