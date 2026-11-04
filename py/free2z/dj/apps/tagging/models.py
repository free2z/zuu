"""Tag governance for free2z: AI *suggestions*  and deterministic
*normalization*.

For  the point is a single sentence: **AI proposes, the creator
decides.** Until then the `zpage-tag` Deployment
(`dj/apps/openai/management/commands/tag_zpages.py`) called `tag_content()` on
a `PAGE_UPDATE` message and did `instance.tags.add(*tags)` -- a silent write of
machine output onto someone else's article, with no consent, no review, and no
record that a machine did it. These tables are where that output lands instead.

Two suggestion models, and the second one is not decoration:

``TagSuggestionRun``
    "We have already suggested for this exact content." Keyed on
    ``(zpage, source_digest)``, so re-running on unchanged content is free --
    it is a unique-constraint hit, not an OpenAI call. It also records the
    passes that produced *nothing*, which a suggestions-only table cannot: with
    only ``TagSuggestion`` rows, an empty result is indistinguishable from
    "never ran" and every redelivery of the same Pub/Sub message would buy
    another completion.

``TagSuggestion``
    One proposed tag and what the creator did about it. ``dismissed`` is
    STICKY: it is keyed on the tag, not on the run, so a creator who rejects
    `technology` is never offered it again on that page no matter how many
    times the article is edited. That is the difference between a suggestion
    and nagging.

Three things the suggestion half deliberately does not do:

* **It never touches ``zpage.tags`` of a page that has tags.** Only
  :func:`accept_suggestions` does, and only ever with ``add()``. Creator-authored
  tags cannot be overwritten or removed by an AI pass because no code path here
  removes a tag. The one machine write  is onto a published page with
  ZERO tags, recorded as ``TagSuggestion.AUTO_APPLIED``.
* **It does not normalize the corpus itself.** ``name`` is stored exactly as
  the model wrote it. ``name_key`` exists only to de-duplicate suggestions
  *within one page* and to make a dismissal survive a case change; it is not a
  canonical form and nothing in the suggestion half reads it as one.
  Normalization is 's job -- the two models below -- which reuses this
  key rather than inventing a second identity for a tag.
* **It is zPage-specific.** ``tag_comments`` has the same shape and could share
  a generic-FK version of this, but a ``GenericForeignKey`` costs the index and
  the cascade behaviour for a second consumer nobody has asked for. A comment
  suggestion table can be added beside this one.

 adds the normalization half: ``TagAlias`` (a variant spelling resolves to
a canonical ``taggit.Tag``) and ``TagNormalizationRun`` (one auditable record
per pass of:doc:`normalize_tags </ref>` -- see
``dj/apps/tagging/management/commands/normalize_tags.py``). The old combine
machinery it replaces destroyed data outright: no alias left behind, no
transaction around the move, no record of what merged into what or why.
"""

import hashlib
import re

from django.conf import settings
from django.db import models
from django.db.models import Q
from django.utils import timezone

from taggit.models import Tag


def content_digest(title: str, content: str) -> str:
    """SHA-256 of the text a tagging pass actually sees.

    Covers the title AND the body because:func:`build_tagging_prompt` feeds
    both to the model -- a retitled article is genuinely different input and
    should be re-tagged, which is why this cannot reuse
    ``dj.apps.g12f.variants.content_digest`` (deliberately body-only, because a
    retitle must NOT invalidate a paid translation).

    The separator is a NUL byte rather than a space so that moving text across
    the title/body boundary changes the digest. With a space,
    ``("ab", "c")`` and ``("a", "bc")`` would hash identically and an edit that
    only moved a word would be silently treated as unchanged content.
    """
    payload = f"{title or ''}\x00{content or ''}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


#`name` is `max_length=100` (matching `taggit.models.Tag.name`), but
#`casefold()` can expand up to 3x for some characters, so the derived key
#needs headroom the name does not.
TAG_KEY_MAX_LENGTH = 300


def tag_key(name: str) -> str:
    """Case- and whitespace-insensitive identity for one tag.

    ``casefold()`` rather than ``lower()``: this platform is multilingual by
    design (the prompt now explicitly asks for tags in the content's own
    language), and ``"STRASSE".lower() != "straße"`` while their casefolds
    agree. Mirrors ``tagKey()`` in ``ts/svelte/free2z/src/lib/tags.js``.
    """
    # Truncated to the column width for safety, not for correctness: casefold
    # can EXPAND a string (`\u00df` -> `ss`, `\ufb04` -> `ffl`), so a
    # 100-character `name` -- the longest the database accepts -- can produce a
    # key of up to 300. The column is sized for that worst case, and this bound
    # means even a future widening of `name` degrades to a collision rather than
    # to a DataError that loses the whole suggestion pass.
    return " ".join((name or "").split()).casefold()[:TAG_KEY_MAX_LENGTH]


class TagSuggestionRun(models.Model):
    """One completed tagging pass over one version of one zPage."""

    zpage = models.ForeignKey(
        "g12f.zPage",
        on_delete=models.CASCADE,
        related_name="tag_suggestion_runs",
    )
    #:func:`content_digest` of the title+body this pass read.
    source_digest = models.CharField(max_length=64, db_index=True)
    #Which model produced it, so a bad batch can be identified after a model
    #bump without guessing from timestamps.
    ai_model = models.CharField(max_length=100, blank=True, default="")
    #How many tags the pass proposed, INCLUDING ones already suggested
    #before. Zero is a real and useful value -- see the module docstring.
    proposed_count = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        constraints = [
            # The whole cost story. A `PAGE_UPDATE` redelivery, a vote that
            # touches `updated_at`, a creator toggling `is_subscriber_only`
            # twice -- none of them buy a completion, because the digest is
            # already here.
            models.UniqueConstraint(
                fields=["zpage", "source_digest"],
                name="uniq_tag_suggestion_run_per_content",
            ),
        ]
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"run {self.source_digest[:8]} on zpage {self.zpage_id}"


class TagSuggestion(models.Model):
    """One proposed tag, and the creator's decision about it."""

    PENDING = "pending"
    ACCEPTED = "accepted"
    DISMISSED = "dismissed"
    #Added to ``zpage.tags`` by the platform, not by the creator.
    #Only ever written for a published page that carried ZERO tags at the
    #moment of the write (decided under the row lock, see
    #``services.record_suggestions``). A distinct status -- not ``accepted``
    #with a NULL ``decided_by`` -- because a deleted creator account also
    #NULLs ``decided_by``, and "did a human choose this tag" must never be
    #an inference.
    AUTO_APPLIED = "auto_applied"
    STATUS_CHOICES = [
        (PENDING, "Pending"),
        (ACCEPTED, "Accepted"),
        (DISMISSED, "Dismissed"),
        (AUTO_APPLIED, "Auto-applied"),
    ]

    zpage = models.ForeignKey(
        "g12f.zPage",
        on_delete=models.CASCADE,
        related_name="tag_suggestions",
    )
    #Exactly as the model wrote it -- casing, spacing, language and all. This
    #is what gets added to `zpage.tags` on accept.
    name = models.CharField(max_length=100)
    #:func:`tag_key` of ``name``. Dedupe/stickiness key only, never a
    #canonical form (see the module docstring).
    name_key = models.CharField(
        max_length=TAG_KEY_MAX_LENGTH, db_index=True)
    status = models.CharField(
        max_length=16, choices=STATUS_CHOICES, default=PENDING, db_index=True
    )
    #Digest of the content version that proposed this tag -- the first one,
    #or, while it is still pending, the latest (: the backfill reuses
    #only pending rows proposed for the page's current content).
    source_digest = models.CharField(max_length=64, blank=True, default="")
    ai_model = models.CharField(max_length=100, blank=True, default="")
    #Who accepted or dismissed it. NULL while pending, and NULL for a
    #decision made by a system path rather than a person.
    decided_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    decided_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            # One row per tag per page, forever. This is what makes a dismissal
            # stick across later runs: the next pass `get_or_create`s and finds
            # the dismissed row rather than resurrecting the tag as pending.
            models.UniqueConstraint(
                fields=["zpage", "name_key"],
                name="uniq_tag_suggestion_per_zpage",
            ),
        ]
        indexes = [
            # The read the editor does on every open: pending suggestions for
            # one page, newest first.
            models.Index(
                fields=["zpage", "status", "-created_at"],
                name="tagsug_zpage_status_idx",
            ),
        ]
        ordering = ["-created_at", "name"]

    def __str__(self) -> str:
        return f"{self.name} ({self.status}) on zpage {self.zpage_id}"

    def save(self, *args, **kwargs):
        # Derived, never hand-set. Keeping it in `save()` means a shell write
        # or a data migration cannot create a row whose key disagrees with its
        # name -- which would quietly break the uniqueness guarantee above.
        self.name_key = tag_key(self.name)
        return super().save(*args, **kwargs)

    def decide(self, status: str, user=None):
        """Record a decision. Does not touch ``zpage.tags`` -- the service does."""
        self.status = status
        self.decided_by = user if (user and user.is_authenticated) else None
        self.decided_at = timezone.now()
        self.save(update_fields=[
            "status", "decided_by", "decided_at", "name_key",
        ])


# ---------------------------------------------------------------------------
# Canonical-with-aliases normalization.
#
# The old combine machinery (`openai.models.combine_tags` and its command /
# admin / LLM pair generation) destroyed data: it moved memberships and deleted
# the variant `Tag` row outright, in no transaction, leaving nothing behind --
# a reader who filtered on the old spelling just got zero results, forever.
# These two models are the representation that makes merging reversible and
# auditable instead: the canonical `Tag` stays, every spelling it absorbed
# lives on as an alias row, and one run row per pass records exactly what
# merged into what and on whose authority.
# ---------------------------------------------------------------------------

class TagAlias(models.Model):
    """One variant spelling that resolves to a canonical ``taggit.Tag``.

    Aliases keep history. Dropping an alias fully reverses a merge decision,
    because the deterministic pass never deletes the original ``Tag`` rows
    unless ``--consolidate`` moved their memberships -- and every such move is
    journaled in:class:`TagNormalizationRun`.
    """

    DETERMINISTIC = "deterministic"
    HUMAN = "human"
    AI = "ai"
    SOURCE_CHOICES = [
        (DETERMINISTIC, "Deterministic"),
        (HUMAN, "Human"),
        (AI, "AI"),
    ]

    #The variant spelling exactly as it existed on a ``Tag`` row.
    name = models.CharField(max_length=100)
    #The public URL spelling of the variant. Indexed so an old URL can be
    #resolved without a crowded, case-insensitive regex scan.
    slug = models.CharField(
        max_length=200,
        blank=True,
        default="",
        db_default="",
        db_index=True,
    )
    #:func:`tag_key` of ``name``. The lookup key for the read path; indexed
    #because every ``?tags=`` term resolves through it.
    name_key = models.CharField(
        max_length=TAG_KEY_MAX_LENGTH, db_index=True)
    #The tag this spelling is absorbed into.
    canonical = models.ForeignKey(
        "taggit.tag",
        on_delete=models.CASCADE,
        related_name="aliases",
    )
    #Who decided the merge. ``deterministic`` rows come from the batch
    #command's case/whitespace grouping alone; ``human`` and ``ai`` exist so
    #later passes ( follow-ups) can record their authority too.
    source = models.CharField(
        max_length=20, choices=SOURCE_CHOICES, default=DETERMINISTIC
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            # One row per (variant key, canonical) pair, which is what makes
            # re-running the pass idempotent. Two DIFFERENT variants may share
            # a canonical -- that is the point. A key mapping to two different
            # canonicals (a conflict) remains representable on purpose: the
            # pass detects it and skips loudly rather than silently remapping
            # history.
            models.UniqueConstraint(
                fields=["name_key", "canonical"],
                name="uniq_tag_alias_per_canonical",
            ),
        ]
        ordering = ["name"]

    def __str__(self) -> str:
        return f"{self.name} -> {self.canonical_id}"

    def save(self, *args, **kwargs):
        # Derived, never hand-set, for the same reason as on TagSuggestion:
        # a shell write or data migration cannot create a row whose key
        # disagrees with its name, which would quietly break lookups.
        self.name_key = tag_key(self.name)
        # Import lazily: ``slugs`` imports this module for ``TagAlias``.
        from .slugs import slugify_tag

        self.slug = slugify_tag(self.name)
        return super().save(*args, **kwargs)


class TagIdentity(models.Model):
    """Indexed projections of the Python tag identity and public URL rules.

    ``taggit.Tag`` is supplied by a third-party app, so its derived fields do
    not belong on that model. Keeping both projections together gives every
    read path the exact same Unicode implementation while allowing PostgreSQL
    to answer slug and alias-group lookups with indexes instead of regexes.
    """

    tag = models.OneToOneField(
        "taggit.tag",
        on_delete=models.CASCADE,
        related_name="tag_identity",
    )
    name_key = models.CharField(max_length=TAG_KEY_MAX_LENGTH, db_index=True)
    slug = models.CharField(max_length=200, blank=True, default="", db_index=True)

    def __str__(self) -> str:
        return f"{self.tag_id}: {self.slug}"


class TagNormalizationRun(models.Model):
    """One invocation of ``manage.py normalize_tags``.

    The ``plan`` JSON is the human-auditable record of exactly what merged
    into what and on whose authority (the ``source`` field on each alias
    written by the run). A pass that finds nothing still writes a row --
    "ran and found nothing" must stay distinguishable from "never ran".
    """

    started_at = models.DateTimeField(auto_now_add=True, db_index=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    #True when the pass computed a plan and wrote no aliases/moves.
    dry_run = models.BooleanField(default=False)
    #True when memberships were actually moved between tags (--consolidate).
    consolidated = models.BooleanField(default=False)
    #Full audit: per canonical tag_key -> {canonical_name, canonical_id,
    #counts, variants:[{name, tag_id, items_moved, alias_created,
    #conflict, deleted}]}.
    plan = models.JSONField(default=dict)
    notes = models.CharField(max_length=500, blank=True, default="")

    class Meta:
        ordering = ["-started_at"]

    def __str__(self) -> str:
        mode = "dry-run" if self.dry_run else (
            "consolidating" if self.consolidated else "aliasing"
        )
        return f"normalize_tags {mode} run {self.pk}"


def resolve_alias_name(term: str) -> str:
    """The canonical name ``term`` maps to via an alias, else ``term``.

    Read-path helper: turns a caller's variant spelling into the canonical tag
    name before any queryset filter runs, so ``?tags=ZCASh`` reaches pages
    tagged ``zcash`` once normalization has recorded the alias. Unknown terms
    -- the overwhelmingly common case -- pass through unchanged, costing one
    indexed lookup per term.

    If conflicting aliases ever map one key to two canonicals, the oldest row
    wins (lowest pk): arbitrary but stable, and the conflict is already being
    reported loudly by the pass that created it.
    """
    alias = (
        TagAlias.objects.filter(name_key=tag_key(term))
        .select_related("canonical")
        .order_by("pk")
        .first()
    )
    if alias is None:
        return term
    return alias.canonical.name


#PostgreSQL advanced-regular-expression metacharacters, escaped before a tag
#name's own text is spliced into a pattern. Slugs are alphanumeric by
#construction so ``dj.apps.tagging.slugs`` can skip this; a ``tag_key`` is
#not — it is a creator-typed name with only case and whitespace folded, so
#``c++ lang`` reaches here verbatim. Unescaped, its ``++`` is not a wrong
#match but a *malformed* pattern: PostgreSQL raises
#``invalid regular expression: quantifier operand invalid``, which surfaces
#as a 500 on ``GET /api/zpage/?tags=c++ lang``. Backslash-escaping is safe
#for exactly these characters — ``\`` before a non-alphanumeric is defined
#as that literal character, while ``\`` before an alphanumeric would be an
#escape sequence (which is why this set is a precise allow-list of
#metacharacters rather than "everything non-alphanumeric").
_REGEX_META_RE = re.compile(r"([\\.^$|()\[\]{}*+?])")

#How many live spellings one alias group's widening will consider. The
#prefilter below is a scan of ``taggit_tag`` reachable by an anonymous caller
#on the public list endpoint, so it gets an explicit ceiling rather than an
#implicit one — the same reasoning, and the same number, as
#``TAG_SLUG_MAX_CANDIDATES``. A group spelled more than this many ways is
#pathological, and truncating it widens less rather than failing.
TAG_GROUP_MAX_SPELLINGS = 50

#Rows the prefilter may return BEFORE Python verifies them, deliberately
#above:data:`TAG_GROUP_MAX_SPELLINGS`. The regex is a superset — PostgreSQL
#folds case through its collation and ``tag_key`` uses ``casefold()``, so
#``^i[[:space:]]+topic$`` can match ``İ topic``, whose Python key is
#different. Slicing at the output cap would let low-pk false positives fill
#the window and push genuine spellings out unverified, quietly delivering
#fewer than the documented 50 for a group that has far fewer than 50
#spellings — the missing-page bug again, one layer down. Still bounded,
#because this is memory allocated on an anonymous read path.
#
#A multiplier is a mitigation, not a proof, and the codex adversarial review
#is right that it can be defeated: a creator who manufactures 200 lower-pk
#``İ<whitespace>topic`` tags fills the window for the key ``i topic`` with
#rows Python then rejects, and that group's widening collapses. The impact
#is bounded to exactly that — one group degrading to its pre-
#resolution, which is the behaviour in production today — and it is not
#closable at this layer: the prefilter is a database regex and the identity
#is a Python ``casefold()``. An indexed ``name_key`` column removes the
#prefilter, and with it this whole class.
TAG_GROUP_CANDIDATE_LIMIT = TAG_GROUP_MAX_SPELLINGS * 4

#How many sequential ``taggit_tag`` scans ONE request may spend widening.
#
#The budget is intrinsic to the memo rather than enforced by each caller,
#and that is the point: the first version put it in the ``?tags=`` loop, and
#the codex adversarial review immediately found
#``/api/tagging/autocomplete`` walking the identical loop with no budget at
#all — 50 selected terms, 50 scans. A rule every caller must remember is a
#rule one caller will forget. Pass a ``cache`` and the ceiling comes with
#it.
#
#It counts SCANS, not terms, and the distinction is load-bearing. The memo
#is keyed on ``tag_key``, so fifty different renderings of one tag — which
#survive an exact-string de-duplication — are one scan and must cost one
#slot. Counting terms instead made the 21st rendering of an ALREADY-CACHED
#group silently drop a page whose answer was sitting in memory, free.
#
#8, against legitimate shapes of one to five ``?tags=`` terms and one tag
#hub's ``any_tags`` names — of which only the multi-token ones scan at all,
#and for which the widening adds little anyway because the hub already
#enumerates every live spelling that slugs to it. So 8 is above real
#traffic and a hard ceiling on the database work one anonymous request can
#buy. Both endpoints are deliberately unthrottled (SSR calls them), so the
#bound has to live here rather than in a throttle. THIS CONSTANT IS THE
#DIAL: lowering it costs nothing but widening on pathological URLs.
#
#Past the ceiling a term resolves exactly the way it did before  —
#fewer pages, never different ones. The permanent fix is an indexed
#``name_key`` column on the tag itself, which turns each of these scans into
#an index lookup and retires this constant;  is already building that
#projection.
LIVE_WIDENING_MAX_SCANS = 8

#Python's ``str.isspace()`` is true for nothing above U+3000, so scanning to
#here enumerates the whole set for a few thousand cheap checks at import
#rather than 1.1M. ``test_the_whitespace_scan_bound_covers_python`` walks the
#ENTIRE code-point space and fails if a future Python ever adds one above
#this bound — the assumption is pinned, not assumed.
_WHITESPACE_SCAN_LIMIT = 0x3001

#Every character:func:`tag_key` collapses, written out as an explicit
#PostgreSQL bracket expression instead of ``[[:space:]]``.
#
#This is not pedantry, it is a measured divergence. ``[[:space:]]`` is
#resolved by the database's ``LC_CTYPE``, and on ``en_US.utf8`` — what the
#CI service container and the production instance both run — it is FALSE for
#8 of the 29 characters Python's ``str.split()`` treats as whitespace:
#U+001C-U+001F (the ASCII file/group/record/unit separators), U+0085 (NEL),
#U+00A0 (NO-BREAK SPACE), U+2007 (FIGURE SPACE) and U+202F (NARROW NO-BREAK
#SPACE). A no-break space is exactly what a word processor or an iOS
#keyboard produces, so ``zero<NBSP>knowledge`` is a spelling real people
#type, ``tag_key`` puts it in the group, and a ``[[:space:]]`` prefilter
#would strand it — reproducing the very bug this code exists to fix,
#silently, and only for the tags that were typed rather than pasted. Under
#the ``C`` locale the class is worse still (ASCII only).
#
#``\uXXXX`` escapes rather than the literal characters: the pattern travels
#as a query parameter, and a bare U+2028 or U+001C in a log line or a
#traceback is invisible. PostgreSQL's ARE dialect defines ``\uwxyz`` as
#"the character with that hexadecimal value", including inside a bracket
#expression. Every member is listed individually — no ranges — because range
#endpoints inside a bracket expression are interpreted by the collation, and
#a range is exactly the thing that would drift with it.
_WHITESPACE_CLASS = "[{}]".format(
    "".join(
        "\\u%04x" % codepoint
        for codepoint in range(_WHITESPACE_SCAN_LIMIT)
        if chr(codepoint).isspace()
    )
)


def _whitespace_variant_pattern(key: str):
    """A PostgreSQL regex matching every name that *could* key to ``key``.

    A deliberate SUPERSET, verified in Python by:func:`live_group_spellings`,
    so the only thing this has to get right is not missing a match: each
    single space in the key — which is where:func:`tag_key` collapsed a run of
    whitespace — becomes ``[[:space:]]+``, and leading/trailing whitespace is
    allowed because the key was stripped.

    Returns ``None`` for a single-token key, and that is a real optimisation
    rather than a special case. Two names with a single-token key can differ
    only by case (or by leading/trailing whitespace, which no write path here
    produces), and every consumer of:func:`resolve_alias_terms` matches with
    ``__iexact`` — so for the overwhelmingly common tag shape the scan could
    not add a single name the caller does not already reach. Skipping it keeps
    ``?tags=zcash`` at exactly the query count it has today even when ``zcash``
    has an alias. ``dj.apps.tagging.slugs._candidate_regex`` skips a
    single-segment slug for the same reason.

    KNOWN LIMIT, and it belongs to the whole approach rather than to the fast
    path: PostgreSQL folds case through its collation and ``tag_key`` folds it
    with Python's ``casefold()``, and the two disagree for characters with a
    special mapping — ``ß`` casefolds to ``ss`` but does not upper-case to
    ``SS`` under libc, and ``İ`` casefolds to ``i`` + U+0307 while glibc
    lowercases it to ``i``. So ``Straße`` and ``STRASSE`` are one group to
    ``tag_key``, and neither ``~*`` here nor the ``__iexact`` every caller
    filters with can match one from the other. This is unchanged, pre-existing
    behaviour — the same divergence ``tags_for_slug`` documents — and it is
    NOT what the single-token fast path trades away: a single-token key skips
    the scan precisely because for such a key the scan could only find names
    ``__iexact`` already reaches, and the casefold-expansion spellings are
    beyond the reach of both. Closing that class needs a stored, indexed
    ``name_key`` column on the tag itself, which is a migration.
    """
    if len(key.split(" ")) < 2:
        return None
    return _tag_key_source_pattern(key)


def _tag_key_source_pattern(key: str):
    """Return a broad SQL prefilter for names deriving to ``key``.

    Unlike:func:`_whitespace_variant_pattern`, this is also used for
    single-token alias keys. Alias rows are imported data and may have leading
    or trailing whitespace, so an ``iexact`` lookup alone would not find every
    source row whose Python-derived key agrees. Callers always verify with
    :func:`tag_key` after this deliberately broad prefilter.
    """
    tokens = key.split(" ")
    body = f"{_WHITESPACE_CLASS}+".join(
        _REGEX_META_RE.sub(r"\\\1", token) for token in tokens
    )
    return f"^{_WHITESPACE_CLASS}*{body}{_WHITESPACE_CLASS}*$"


def live_group_spellings(key: str, cache: dict = None) -> set:
    """Live ``taggit`` tag names whose:func:`tag_key` is ``key``.

    At most:data:`TAG_GROUP_MAX_SPELLINGS` of them, lowest pk first, and the
    cap is a real answer rather than a formality: a group spelled 51 ways
    loses its highest-pk spelling from the widening and the pages carrying
    only that spelling stay unreachable. That is the deliberate trade — an
    unbounded widening is an unbounded ``OR`` chain on the public list
    endpoint's tag join, which fails the whole request rather than one corner
    of it. ``test_widening_is_capped_at_the_documented_bound`` walks the
    boundary so the number is observable instead of theoretical.

    This is the half of an alias group the alias table cannot describe.
    ``normalize_tags._ensure_alias`` writes one row per ``(name_key,
    canonical)`` pair — the unique constraint permits no more — so a group
    with three spellings records exactly ONE of them and the third is absent
    from ``TagAlias`` entirely. Reading the group back out of the
    alias table alone therefore returns a set that is symmetric for two
    spellings and silently short for three.

    ``cache`` is a caller-supplied dict scoped to ONE request, and it carries
    BOTH halves of the bound in the presence of a hostile URL: the memo, and
    :data:`LIVE_WIDENING_MAX_SCANS` scans measured by its own size (single-
    token keys are answered without a query and deliberately not recorded, so
    ``len(cache)`` is exactly the number of scans performed). The scan is keyed
    on ``tag_key``, so every spelling of a group asks the identical question:
    ``?tags=`` with 50 case/whitespace variants of one known alias defeats a
    de-duplication on the exact string but collapses to a SINGLE scan here.
    Autocomplete resolves its selected terms twice — once to exclude them,
    once to narrow the counted corpus — and one shared cache makes the second
    pass free. It is not a process-level cache on purpose: tags are created by
    ordinary page edits, and a stale entry is a spelling that has stopped
    being reachable with no event to invalidate it.

    Cost: one sequential scan of ``taggit_tag`` for a multi-token key, on a
    read path an anonymous caller reaches. It is spent only when the term
    already matched an alias row (so the corpus has been normalized and the
    group really is more than one spelling) AND the key has more than one
    token; single-token keys — the overwhelmingly common shape — never reach
    here. No index can serve an anchored case-insensitive regex, the table is
    small (thousands of rows, not millions), and the query is a single
    unjoined ``values_list`` bounded by:data:`TAG_GROUP_MAX_SPELLINGS`. CI
    does not validate this query plan, so treat the bound as reasoned, not
    measured; if it ever bites, the fix is a stored key column, which is a
    migration.
    """
    if cache is not None:
        if key in cache:
            return cache[key]
        if len(cache) >= LIVE_WIDENING_MAX_SCANS:
            # Budget spent. Returning nothing degrades this term to its
            # pre- resolution -- a narrower filter, never a wrong one.
            return set()
    pattern = _whitespace_variant_pattern(key)
    if pattern is None:
        # NOT cached: a single-token key issues no query, and the caller's
        # scan budget is `len(cache)`. Recording a free answer there would
        # spend a slot that exists to bound SCANS.
        return set()
    candidates = (
        Tag.objects.filter(name__iregex=pattern)
        .order_by("pk")
        .values_list("name", flat=True)[:TAG_GROUP_CANDIDATE_LIMIT]
    )
    # Verified in Python against the ONE definition of tag identity, so the
    # SQL above is only ever a prefilter and no PostgreSQL regex subtlety can
    # widen a filter onto a tag that is not in the group. The output cap is
    # applied AFTER verification -- see TAG_GROUP_CANDIDATE_LIMIT.
    verified = [name for name in candidates if tag_key(name) == key]
    spellings = set(verified[:TAG_GROUP_MAX_SPELLINGS])
    if cache is not None:
        cache[key] = spellings
    return spellings


def resolve_alias_terms(term: str, live_cache: dict = None) -> list:
    """Every spelling a read path should match for ``term`` — never fewer.

    ``resolve_alias_name`` REDIRECTS: it swaps the caller's spelling for the
    canonical one, which narrows a filter to the canonical's corpus and makes
    pages carrying any other spelling unreachable through it (
    follow-up). Read paths must WIDEN instead. The returned set is symmetric
    within an alias group — ``term``, the canonical name, every recorded alias
    spelling sharing its ``name_key``, and every LIVE tag sharing it — so
    filtering on ANY member reaches the whole group's corpus. Unknown terms
    return just ``[term]``: the same single indexed lookup as before, no
    behaviour change on the overwhelmingly common path.

    That last source is the  fix and it is not redundant with the alias
    table. ``TagAlias`` is unique on ``(name_key, canonical)``, so a group can
    record only ONE variant spelling however many exist; at three whitespace
    spellings the third appears in no alias row, and this function used to
    return a set that omitted it. The symmetry it documents was therefore true
    only at two spellings — where ``{term} | {canonical} | {the one alias}``
    covers the group by construction and stranding is impossible — and the
    test that pinned it used exactly two. ``GET /api/zpage/?tags=zero
    knowledge``, the canonical spelling every chip and ``/tag/<slug>`` hub
    links to, returned two of three pages, with no error and nothing to see.

    The alias rows are still unioned in, and deliberately so: ``--consolidate``
    DELETES a variant ``Tag`` once its memberships have moved, so the alias
    table is the only remaining record of a spelling a caller may still hold a
    link to. Live tags and recorded aliases answer different questions
    ("what can a page carry today" vs "what was this group ever called"), and
    the read path wants both.

    ``live_cache`` is a per-request dict that a caller in a loop passes to
    every call. It memoizes the live-tag scan by ``tag_key`` AND carries the
    per-request scan budget, so a caller that hands one over cannot forget the
    ceiling; see:func:`live_group_spellings`. Every read path that resolves
    more than one term passes one -- ``?tags=``, ``?any_tags=`` and both
    autocomplete loops, sharing a single dict per request. Past the budget a
    term resolves the way it did before: FEWER pages than the widened
    form, never different ones, which is precisely the shipped behaviour a
    pathological URL degrades to.
    """
    names = {term}
    key = tag_key(term)
    first = (
        TagAlias.objects.filter(name_key=key)
        .select_related("canonical")
        .order_by("pk")
        .first()
    )
    # `name_key` is derived and bulk/raw writes bypass TagAlias.save(). If the
    # indexed hit is stale, use the bounded source table as the authority
    # rather than silently narrowing a public tag filter. An indexed miss is
    # the normal, no-alias path. Do not turn it into a full-table scan: this
    # helper runs once per term on the public zPage list endpoint, and an
    # unrelated alias corpus must not make `?tags=zcash` return a 500.
    if first is None:
        return sorted(names)

    matching = None
    if first.name_key != key or tag_key(first.name) != key:
        from .slugs import TAG_ALIAS_MAX_SOURCE_CANDIDATES, TagGraphTooLarge

        source_aliases = list(
            TagAlias.objects.filter(
                Q(name_key=key)
                | Q(name__iregex=_tag_key_source_pattern(key))
            )
            .select_related("canonical")
            .order_by("pk")[: TAG_ALIAS_MAX_SOURCE_CANDIDATES + 1]
        )
        if len(source_aliases) > TAG_ALIAS_MAX_SOURCE_CANDIDATES:
            raise TagGraphTooLarge
        aliases = {alias.pk: alias for alias in source_aliases}
        aliases[first.pk] = first
        matching = [
            alias for alias in aliases.values() if tag_key(alias.name) == key
        ]
        if not matching:
            return sorted(names)
        first = min(matching, key=lambda alias: alias.pk)

    names.add(first.canonical.name)
    # `|=` rather than `.update()`: the URL write-guard statically flags any
    # `.update(` inside a read path, and it cannot tell a set-update from a
    # QuerySet UPDATE.
    if matching is None:
        names |= set(
            TagAlias.objects.filter(name_key=key).values_list(
                "name", flat=True
            )
        )
    else:
        names |= {alias.name for alias in matching}
    names |= live_group_spellings(key, cache=live_cache)
    return sorted(names)
