"""Deterministic tag normalization is safe, idempotent and journaled.

``manage.py normalize_tags`` replaces ``openai.models.combine_tags``, which
moved rows in autocommit mode, destroyed variant ``Tag`` rows outright, left
no alias behind and kept no record. Every test here pins one property the old
machinery got wrong, stated as behaviour:

* the canonical is elected by **total membership across BOTH through tables**
  -- counting only ``taggit.TaggedItem`` elects the wrong spelling whenever a
  variant lives mostly on comments;
* a rerun on an already-normalized corpus is a no-op, including when one group
  holds several spellings that share a ``name_key``;
* an alias that already maps a key to a DIFFERENT canonical is skipped loudly
  and recorded in the plan -- never silently remapped;
* ``--dry-run`` writes nothing but its own audit row;
* ``--consolidate`` moves memberships across ``taggit.TaggedItem`` AND
  ``comments.UUIDTaggedItem``, journals every move, and deletes a variant only
  once nothing references it anywhere;
* the read path honours what the write path recorded: ``GET /api/zpage/?tags=``
  widens a whitespace variant through its alias instead of stranding any
  spelling -- pinned at THREE spellings, because at two the widening cannot
  fail however it is implemented and the assertion proves nothing;
* a reversal removes only canonical memberships created by its own run,
  including when the pre-existing membership lives on a comment.

The database is real Postgres; nothing external is involved, so nothing is
stubbed beyond the conftest-wide Pub/Sub stand-in.
"""

import json
import uuid
from io import StringIO

import pytest
from django.contrib.contenttypes.models import ContentType
from django.core.management import CommandError, call_command
from django.db import connection
from django.test.utils import CaptureQueriesContext
from taggit.models import Tag, TaggedItem

from dj.apps.comments.models import Comment, UUIDTaggedItem
from dj.apps.g12f.models import zPage
from dj.apps.tagging.models import (
    LIVE_WIDENING_MAX_SCANS,
    TAG_GROUP_MAX_SPELLINGS,
    _WHITESPACE_SCAN_LIMIT,
    TagAlias,
    TagNormalizationRun,
    live_group_spellings,
    resolve_alias_name,
    resolve_alias_terms,
    tag_key,
)


def _page(creator, tags=(), title="Recursion"):
    page = zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        vanity=f"article-{uuid.uuid4()}",
        title=title,
        content="Some content long enough to stand in for a real article.",
        is_published=True,
    )
    if tags:
        page.tags.add(*tags)
    return page


def _comment(author, text="A comment worth tagging, like all comments."):
    return Comment.objects.create(author=author, content=text)


def _run_normalize(*args):
    """Run the command, returning its captured stdout."""
    out = StringIO()
    call_command("normalize_tags", *args, stdout=out)
    return out.getvalue()


# ---------------------------------------------------------------------------
# 1. Canonical election sees BOTH through tables
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_canonical_is_elected_by_membership_across_both_through_tables(
    creator_factory,
):
    """``Python`` wins ONLY because its comment memberships are counted.

    On the int-PK table alone (2 vs 1) ``PYTHON`` would win; the two
    ``UUIDTaggedItem`` rows flip the total to 3 vs 2. This is the property
    that makes cross-table counting load-bearing rather than decorative.
    """
    creator = creator_factory()
    _page(creator, tags=["Python"])
    _comment(creator).tags.add("Python")
    _comment(creator).tags.add("Python")
    _page(creator, tags=["PYTHON"])
    _page(creator, tags=["PYTHON"])
    _page(creator, tags=["pyThon"])

    _run_normalize()

    run = TagNormalizationRun.objects.get()
    assert run.dry_run is False
    assert run.finished_at is not None
    group = run.plan[tag_key("Python")]
    assert group["canonical_name"] == "Python"
    assert group["canonical_id"] == Tag.objects.get(name="Python").pk
    # Three spellings, six memberships total across both tables.
    assert group["counts"]["members"] == 3
    assert group["counts"]["memberships"] == 6
    # Aliasing-only pass: every variant resolves to the canonical. One alias
    # ROW per (name_key, canonical) -- all three spellings casefold to the
    # key "python", and uniq_tag_alias_per_canonical keeps exactly one row
    # for that pair (the same contract test #2 pins). Resolution is keyed on
    # tag_key(name), not on the stored spelling, so each variant spelling --
    # and the canonical itself -- still reaches the canonical tag.
    assert TagAlias.objects.count() == 1
    alias = TagAlias.objects.get()
    assert alias.canonical_id == Tag.objects.get(name="Python").pk
    assert alias.name_key == tag_key(alias.name)
    for spelling in ("Python", "PYTHON", "pyThon"):
        assert resolve_alias_name(spelling) == "Python"
    #...and nothing was moved, so the journal claims no movement.
    for entry in group["variants"]:
        assert entry["items_moved"] == 0
        assert entry["deleted"] is False


# ---------------------------------------------------------------------------
# 2. Idempotent rerun
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_a_rerun_creates_no_new_aliases_and_journals_itself(creator_factory):
    """Re-running on a quiet corpus changes nothing and crashes nowhere.

    The corpus is the nasty case: three spellings of ONE key in a single
    group. The second variant shares its ``name_key`` with the alias the
    first one just wrote, so a lookup keyed on ``(name, canonical)`` misses,
    attempts a duplicate INSERT and dies on
    ``uniq_tag_alias_per_canonical``.
    """
    creator = creator_factory()
    _page(creator, tags=["python"])
    _page(creator, tags=["PYTHON"])
    _page(creator, tags=["PyThon"])

    _run_normalize()
    after_first = TagAlias.objects.count()
    assert after_first == 1

    _run_normalize()

    # One alias row, still pointing where the first run put it.
    assert TagAlias.objects.count() == after_first
    alias = TagAlias.objects.get()
    assert alias.canonical.name == "python"
    assert alias.name_key == tag_key(alias.name)
    # Both passes are journaled; the second reports creating nothing.
    assert TagNormalizationRun.objects.count() == 2
    second_run = TagNormalizationRun.objects.order_by("pk").last()
    for entry in second_run.plan["python"]["variants"]:
        assert entry["alias_created"] is False
        assert entry["conflict"] is None


# ---------------------------------------------------------------------------
# 3. A conflicting alias is skipped and recorded, never remapped
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_an_alias_that_already_maps_elsewhere_is_skipped_and_recorded(
    creator_factory,
):
    """An earlier decision owns the key; this pass may not overrule it."""
    creator = creator_factory()
    other_creator = creator_factory()
    _page(creator, tags=["rust"])
    mixed = _page(other_creator, tags=["gardening", "RUST"])
    gardening = TaggedItem.objects.get(
        object_id=mixed.pk, tag__name="gardening").tag
    assert gardening.name == "gardening"

    # A previous (human) decision: "RUST" means the gardening tag.
    prior = TagAlias.objects.create(name="RUST", canonical=gardening)

    out = _run_normalize()

    # Skipped LOUDLY, in the output and in the plan.
    assert "CONFLICT" in out
    run = TagNormalizationRun.objects.get()
    entry = next(
        e for e in run.plan[tag_key("rust")]["variants"]
        if e["name"] == "RUST"
    )
    assert entry["conflict"]["existing_alias_id"] == prior.pk
    assert entry["conflict"]["existing_canonical_id"] == gardening.pk
    assert entry["alias_created"] is False
    # And never silently remapped: exactly the pre-existing mapping remains.
    assert TagAlias.objects.count() == 1
    prior.refresh_from_db()
    assert prior.canonical_id == gardening.pk


@pytest.mark.django_db
def test_normalization_guard_uses_source_key_when_projection_is_stale(
    creator_factory,
):
    """A stale stored key must not bypass the read path's conflict guard."""
    gardening = Tag.objects.create(name="gardening")
    variant = Tag.objects.create(name="rust ")
    Tag.objects.create(name="RUST")
    TagAlias.objects.bulk_create([
        TagAlias(
            name="Rust",
            name_key="stale-rust-key",
            canonical=gardening,
        )
    ])
    _page(creator_factory(), tags=[variant])

    out = _run_normalize()

    assert "CONFLICT" in out
    assert TagAlias.objects.filter(canonical=variant).exists() is False


# ---------------------------------------------------------------------------
# 4. Dry-run computes everything and writes nothing
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_a_dry_run_writes_nothing_but_its_own_audit_row(creator_factory):
    creator = creator_factory()
    _page(creator, tags=["Zcash"])
    _page(creator, tags=["ZCASh"])
    tagged_items_before = TaggedItem.objects.count()
    uuid_items_before = UUIDTaggedItem.objects.count()
    tags_before = Tag.objects.count()

    out = _run_normalize("--dry-run")

    # No effects: no aliases, no membership moves, no tag churn.
    assert TagAlias.objects.exists() is False
    assert TaggedItem.objects.count() == tagged_items_before
    assert UUIDTaggedItem.objects.count() == uuid_items_before
    assert Tag.objects.count() == tags_before
    #...except the deliberate audit row, so a found-nothing pass is not
    # indistinguishable from a never-ran one.
    runs = TagNormalizationRun.objects.all()
    assert runs.count() == 1
    run = runs.get()
    assert run.dry_run is True
    assert run.consolidated is False
    assert run.finished_at is not None
    assert run.plan[tag_key("ZCASh")]["canonical_name"] == "Zcash"
    # The plan itself was printed for the operator.
    assert "[zcash]" in out

    # An invalid invocation journals NOTHING at all.
    with pytest.raises(CommandError):
        _run_normalize("--dry-run", "--consolidate")
    assert TagNormalizationRun.objects.count() == 1


# ---------------------------------------------------------------------------
# 5. --consolidate moves across both tables and deletes only true orphans
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_consolidation_moves_both_through_tables_and_deletes_orphans(
    creator_factory,
):
    creator = creator_factory()
    keeper = _page(creator, tags=["crypto"])
    # Carries BOTH spellings: moving the variant onto the canonical must
    # dedupe against the existing row, not create a second membership.
    carrier = _page(creator, tags=["CRYPTO", "crypto"])
    comment = _comment(creator)
    comment.tags.add("CRYPTO")
    bystander = _page(creator, tags=["gardening"])

    _run_normalize("--consolidate")

    run = TagNormalizationRun.objects.get()
    assert run.consolidated is True
    assert run.finished_at is not None
    entry = run.plan[tag_key("crypto")]["variants"][0]
    assert entry["name"] == "CRYPTO"
    # One row from each through table was moved, and journaled as pairs.
    assert entry["items_moved"] == 2
    assert entry["deleted"] is True
    zpage_ct = ContentType.objects.get_for_model(zPage)
    comment_ct = ContentType.objects.get_for_model(Comment)
    # Triples now carry ``created``: the carrier already held "crypto", so
    # its canonical membership was NOT created by this run (False); the
    # comment carried only "CRYPTO", so this run added its canonical (True).
    assert sorted(entry["moved_pairs"], key=lambda triple: triple[0]) == sorted(
        [
            [zpage_ct.pk, carrier.pk, False],
            [comment_ct.pk, str(comment.uuid), True],
        ],
        key=lambda triple: triple[0],
    )
    # The variant is gone, and gone from both tables.
    assert TaggedItem.objects.filter(tag__name="CRYPTO").exists() is False
    assert (
        UUIDTaggedItem.objects.filter(tag__name="CRYPTO").exists() is False
    )
    # Every former carrier now carries the canonical -- exactly once.
    assert list(carrier.tags.names()) == ["crypto"]
    assert TaggedItem.objects.filter(object_id=carrier.pk).count() == 1
    assert list(comment.tags.names()) == ["crypto"]
    # Bystanders untouched.
    assert list(keeper.tags.names()) == ["crypto"]
    assert list(bystander.tags.names()) == ["gardening"]


# ---------------------------------------------------------------------------
# 6. The read path resolves variants through their aliases
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_zpage_list_resolves_a_variant_through_its_alias(
    api_client, creator_factory,
):
    """The alias turns a dead spelling into live results.

    The variants differ by WHITESPACE on purpose: a case-only difference
    would already match ``__iexact`` and prove nothing about resolution.
    """
    creator = creator_factory()
    canonical_page = _page(
        creator, tags=["zero knowledge"], title="Single spaced")
    variant_page = _page(creator, tags=["zero  knowledge"], title="Double spaced")
    bystander = _page(creator, tags=["gardening"], title="Unrelated")

    _run_normalize()

    # WIDENING, not redirecting ( follow-up): either spelling must reach
    # BOTH pages. The earlier assertion here expected exactly the canonical
    # page -- which locked the stranding in: redirecting the term made the
    # variant-carrying page unreachable by ANY tag term.
    response = api_client.get("/api/zpage/", {"tags": "zero  knowledge"})
    assert response.status_code == 200, response.content
    via_variant = {row["free2zaddr"] for row in response.data["results"]}
    assert via_variant == {
        canonical_page.free2zaddr,
        variant_page.free2zaddr,
    }

    # And the canonical spelling reaches both directions of the group too.
    response = api_client.get("/api/zpage/", {"tags": "zero knowledge"})
    assert response.status_code == 200, response.content
    assert {
        row["free2zaddr"] for row in response.data["results"]
    } == via_variant

    assert bystander.free2zaddr not in via_variant


@pytest.mark.django_db
def test_alias_term_resolution_widens_every_whitespace_spelling(
    creator_factory,
):
    """Canonical and whitespace-variant reads share one result set.

    The API test above proves the public route, while this pins the helper's
    exact contract: every input retains the caller's spelling and includes
    every other spelling. A redirect-only implementation returns one name and
    strands the pages carrying the wider-spaced tags.

    THREE spellings, not two, and that is the whole point. At two,
    ``{term} | {canonical.name} | {the one recorded alias}`` covers the group
    by construction whatever the implementation does, so stranding is
    structurally impossible and this assertion was unfalsifiable. At three,
    ``TagAlias``'s ``(name_key, canonical)`` uniqueness means only ONE variant
    spelling is ever recorded and the alias table alone answers short.
    """
    creator = creator_factory()
    for spelling in ("zero knowledge", "zero  knowledge", "zero   knowledge"):
        _page(creator, tags=[spelling])

    _run_normalize()

    # The premise, asserted rather than assumed: one group, ONE alias row --
    # so two of the three spellings exist nowhere in the alias table.
    assert TagAlias.objects.count() == 1
    recorded = set(TagAlias.objects.values_list("name", flat=True))
    assert len(recorded) == 1

    # Sorted, and the order is Python's: a space sorts below `k`, so the
    # triple-spaced spelling comes first.
    whole_group = [
        "zero   knowledge",
        "zero  knowledge",
        "zero knowledge",
    ]
    for spelling in whole_group:
        assert resolve_alias_terms(spelling) == whole_group, spelling


@pytest.mark.django_db
def test_alias_term_resolution_reaches_a_spelling_only_a_regex_can_match(
    creator_factory,
):
    """Widening is keyed on ``tag_key``, not on "the name with spaces in it".

    A fix that only tried the canonical name and its space-joined reading --
    the shape of ``slug.replace("-", " ")`` -- rescues the double-spaced page
    and leaves this one exactly as stranded as before. ``tag_key`` collapses
    every run of whitespace, so a TAB-separated spelling is the same tag, is
    reachable by no ``__iexact`` on any other spelling, and is what proves the
    matcher is the general one.
    """
    creator = creator_factory()
    for spelling in ("zero knowledge", "zero  knowledge", "zero\tknowledge"):
        _page(creator, tags=[spelling])

    _run_normalize()

    assert tag_key("zero\tknowledge") == "zero knowledge"
    for spelling in ("zero knowledge", "zero  knowledge", "zero\tknowledge"):
        assert set(resolve_alias_terms(spelling)) == {
            "zero knowledge",
            "zero  knowledge",
            "zero\tknowledge",
        }, spelling


@pytest.mark.django_db
def test_alias_term_resolution_survives_regex_metacharacters_in_the_name(
    api_client, creator_factory,
):
    """A tag name is creator-typed text, not a slug, and lands in a pattern.

    ``c++ lang`` splices ``++`` into the PostgreSQL prefilter. Unescaped that
    is not a wrong match but a MALFORMED pattern -- ``invalid regular
    expression: quantifier operand invalid`` -- which reaches the caller as a
    500 on the main public list endpoint. The negative control for the escape
    is this test failing with a DataError, not with a missing page.
    """
    creator = creator_factory()
    pages = {}
    for spelling in ("c++ lang", "c++  lang", "c++   lang"):
        pages[spelling] = _page(creator, tags=[spelling], title=spelling)

    _run_normalize()

    assert set(resolve_alias_terms("c++ lang")) == set(pages)

    response = api_client.get("/api/zpage/", {"tags": "c++ lang"})
    assert response.status_code == 200, response.content
    assert {row["free2zaddr"] for row in response.data["results"]} == {
        page.free2zaddr for page in pages.values()
    }


@pytest.mark.django_db
def test_zpage_list_reaches_the_third_whitespace_spelling(
    api_client, creator_factory,
):
    """The reported failure, as the reporter measured it.

    Three pages, three whitespace spellings of one tag, and the CANONICAL
    spelling -- the one every tag chip and every ``/tag/<slug>`` hub links to
    -- returned two of the three. Silent: a 200 with an article missing.
    """
    creator = creator_factory()
    pages = {}
    for spelling in ("zero knowledge", "zero  knowledge", "zero   knowledge"):
        pages[spelling] = _page(creator, tags=[spelling], title=spelling)
    bystander = _page(creator, tags=["gardening"], title="Unrelated")

    _run_normalize()
    # The alias table records one row for this three-spelling group; the
    # read-side live widening must supply the other two spellings.
    assert TagAlias.objects.count() == 1

    expected = {page.free2zaddr for page in pages.values()}
    for spelling in pages:
        response = api_client.get("/api/zpage/", {"tags": spelling})
        assert response.status_code == 200, response.content
        found = {row["free2zaddr"] for row in response.data["results"]}
        assert found == expected, spelling
        assert bystander.free2zaddr not in found


@pytest.mark.django_db
def test_tag_hub_count_agrees_with_the_tags_filter(
    api_client, creator_factory,
):
    """The hub and the filter must describe the SAME corpus.

    ``/tag/<slug>`` resolves its spellings from live ``Tag`` rows through a
    regex, so it has always found all three; ``?tags=`` resolved them from the
    alias table, which records one. The hub therefore advertised ``count: 3``
    above a list that returned 2 -- a number that disagrees with the very
    pages it sits on top of, and a pagination that runs past the end.

    Asserted for EVERY name the hub publishes, not just its headline one. The
    stranded spelling is the one that always worked (its own term seeds the
    set), so a test that happens to filter on it passes while the bug is fully
    present -- and the hub's headline name is decided by usage, which a
    fixture can tie.
    """
    creator = creator_factory()
    for spelling in ("zero knowledge", "zero  knowledge", "zero   knowledge"):
        _page(creator, tags=[spelling], title=spelling)

    _run_normalize()

    hub = api_client.get("/api/tagging/hub/zero-knowledge")
    assert hub.status_code == 200, hub.content
    payload = hub.json()
    assert sorted(payload["names"]) == [
        "zero   knowledge",
        "zero  knowledge",
        "zero knowledge",
    ]
    assert payload["count"] == 3

    for name in payload["names"]:
        listed = api_client.get("/api/zpage/", {"tags": name})
        assert listed.status_code == 200, listed.content
        assert listed.data["count"] == payload["count"], name


@pytest.mark.django_db
def test_case_only_variants_still_resolve_through_iexact(
    api_client, creator_factory,
):
    """The other spelling class, which this change must not disturb.

    Case variants were never stranded: ``tags__name__iexact`` unifies them at
    the filter whether or not the alias table records them, which is why a
    THREE-spelling case group works today and the identical whitespace group
    does not. Pinned so the widening cannot regress into being load-bearing
    for a case the database already handles -- and note the single-token key
    here takes the fast path that skips the tag scan entirely.
    """
    creator = creator_factory()
    pages = [
        _page(creator, tags=[spelling], title=spelling)
        for spelling in ("Python", "PYTHON", "pyThon")
    ]

    _run_normalize()

    expected = {page.free2zaddr for page in pages}
    for spelling in ("Python", "PYTHON", "pyThon", "python"):
        response = api_client.get("/api/zpage/", {"tags": spelling})
        assert response.status_code == 200, response.content
        assert {
            row["free2zaddr"] for row in response.data["results"]
        } == expected, spelling


@pytest.mark.django_db
def test_alias_resolution_query_cost_is_bounded(
    creator_factory, django_assert_num_queries,
):
    """What the widening costs, per shape, asserted rather than assumed.

    ``resolve_alias_terms`` runs on ``GET /api/zpage/?tags=``, the main public
    list endpoint, once per term. An earlier draft of this code loaded the
    whole alias table on the NO-ALIAS path and turned ``?tags=zcash`` into a
    500, so the no-alias count is the one that must not move: it is a single
    indexed lookup and it stays one.

    The single-token fast path matters for the same reason: ``zcash`` having
    an alias must not buy every request a scan of ``taggit_tag`` it provably
    cannot learn anything from.
    """
    creator = creator_factory()
    for spelling in ("zero knowledge", "zero  knowledge", "zero   knowledge"):
        _page(creator, tags=[spelling])
    for spelling in ("Python", "PYTHON", "pyThon"):
        _page(creator, tags=[spelling])

    _run_normalize()

    # No alias for this key at all: one indexed lookup, unchanged.
    with django_assert_num_queries(1):
        assert resolve_alias_terms("gardening") == ["gardening"]

    # Single-token key WITH an alias: the alias lookup and the alias-name
    # union, and no tag scan -- `__iexact` already reaches every case
    # spelling, so the scan could only find names the caller has.
    with django_assert_num_queries(2):
        resolve_alias_terms("Python")

    # Multi-token key with an alias: one more query, and exactly one.
    with django_assert_num_queries(3):
        assert len(resolve_alias_terms("zero knowledge")) == 3




@pytest.mark.django_db
def test_widening_matches_every_character_python_calls_whitespace(
    creator_factory,
):
    """``[[:space:]]`` is not the set ``tag_key`` collapses, and the gap bites.

    PostgreSQL resolves ``[[:space:]]`` through the database's ``LC_CTYPE``.
    Measured on ``en_US.utf8`` (what the CI service container and the
    production instance run), it is FALSE for 8 of the 29 characters Python's
    ``str.split()`` treats as whitespace: U+001C-U+001F, U+0085, **U+00A0**,
    U+2007 and U+202F. A no-break space is what a word processor or an iOS
    keyboard produces, so ``zero<NBSP>knowledge`` is a spelling real people
    type, ``tag_key`` puts it in the group, and a ``[[:space:]]`` prefilter
    strands it -- silently reproducing the exact bug this module now fixes,
    for precisely the tags that were typed rather than pasted.

    One query covers the whole class: every spelling shares one key.
    """
    whitespace = [
        chr(codepoint)
        for codepoint in range(_WHITESPACE_SCAN_LIMIT)
        if chr(codepoint).isspace()
    ]
    assert "\u00a0" in whitespace and "\t" in whitespace

    canonical = Tag.objects.create(name="zero knowledge")
    spellings = {"zero knowledge"}
    for character in whitespace:
        name = f"zero{character}knowledge"
        spellings.add(name)
        Tag.objects.get_or_create(name=name)
    TagAlias.objects.create(name="zero  knowledge", canonical=canonical)

    assert live_group_spellings("zero knowledge") == spellings
    # Plus the alias row's own spelling, which is not a live tag here -- the
    # two sources answer different questions and both belong in the union.
    assert set(resolve_alias_terms("zero knowledge")) == (
        spellings | {"zero  knowledge"}
    )


def test_the_whitespace_scan_bound_covers_python(
):
    """Nothing above the scanned range is whitespace to Python.

    The class is built by scanning code points below
    :data:`_WHITESPACE_SCAN_LIMIT` so it costs microseconds at import. That is
    only correct while the assumption holds, so the assumption is checked
    against the ENTIRE code-point space here rather than believed.
    """
    beyond = [
        codepoint
        for codepoint in range(_WHITESPACE_SCAN_LIMIT, 0x110000)
        if chr(codepoint).isspace()
    ]
    assert beyond == []


@pytest.mark.django_db
def test_a_no_break_space_spelling_is_reachable_from_the_canonical(
    api_client, creator_factory,
):
    """The same fix, end to end on the public route.

    Three spellings again, but the third differs by a NO-BREAK SPACE rather
    than by a doubled ASCII space -- the shape a creator gets by pasting from
    a document. Reverting the explicit whitespace class to ``[[:space:]]``
    fails here and nowhere else in this file.
    """
    creator = creator_factory()
    pages = {}
    for spelling in ("zero knowledge", "zero  knowledge", "zero\u00a0knowledge"):
        pages[spelling] = _page(creator, tags=[spelling], title=repr(spelling))

    _run_normalize()

    expected = {page.free2zaddr for page in pages.values()}
    for spelling in pages:
        response = api_client.get("/api/zpage/", {"tags": spelling})
        assert response.status_code == 200, response.content
        assert {
            row["free2zaddr"] for row in response.data["results"]
        } == expected, repr(spelling)


@pytest.mark.django_db
def test_widening_is_capped_at_the_documented_bound(creator_factory):
    """The cap is a real answer, so it is walked rather than asserted about.

    An unbounded widening is an unbounded ``OR`` chain on the public list
    endpoint's tag join. Bounding it means a group spelled past the bound
    loses its highest-pk spellings -- the trade is stated in
    :func:`live_group_spellings` and this is what makes the number visible.
    """
    canonical = Tag.objects.create(name="zero knowledge")
    TagAlias.objects.create(name="zero  knowledge", canonical=canonical)
    # One spelling per extra space, all sharing the key, created in pk order.
    for extra in range(1, TAG_GROUP_MAX_SPELLINGS + 5):
        Tag.objects.create(name="zero" + " " * (extra + 1) + "knowledge")

    resolved = live_group_spellings("zero knowledge")
    assert len(resolved) == TAG_GROUP_MAX_SPELLINGS
    # Lowest pk first, so it is the LAST spellings that fall off -- the ones
    # created most recently, not an arbitrary subset.
    assert "zero knowledge" in resolved
    assert "zero" + " " * (TAG_GROUP_MAX_SPELLINGS + 5) + "knowledge" \
        not in resolved


@pytest.mark.django_db
def test_repeated_tags_terms_cost_no_extra_widening(
    api_client, creator_factory,
):
    """A repeated `?tags=` term is de-duplicated, not re-resolved.

    `tags` is ANDed, so repeating a term cannot change the result -- but it
    used to buy another alias lookup and, after, another table scan.
    Hundreds of repeats of one known aliased term is the cheapest way to turn
    this endpoint into work, and it needs no unusual corpus at all.
    """
    creator = creator_factory()
    for spelling in ("zero knowledge", "zero  knowledge", "zero   knowledge"):
        _page(creator, tags=[spelling], title=spelling)

    _run_normalize()

    with CaptureQueriesContext(connection) as single:
        once = api_client.get("/api/zpage/", {"tags": "zero knowledge"})
    assert once.status_code == 200, once.content
    baseline = {row["free2zaddr"] for row in once.data["results"]}
    assert len(baseline) == 3

    repeated = ",".join(["zero knowledge"] * 40)
    with CaptureQueriesContext(connection) as many:
        response = api_client.get("/api/zpage/", {"tags": repeated})
    assert response.status_code == 200, response.content
    assert {row["free2zaddr"] for row in response.data["results"]} == baseline
    # Byte-for-byte the same work: 40 repeats collapse to one term.
    assert len(many) == len(single)


@pytest.mark.django_db
def test_many_spellings_of_one_group_cost_one_scan(
    api_client, creator_factory,
):
    """De-duplicating the exact string is not enough, and here is why.

    ``?tags=`` ANDs its terms, so a repeat can be dropped -- but ``zero
    knowledge``, ``ZERO KNOWLEDGE`` and ``zero  knowledge`` are three
    DIFFERENT strings that survive de-duplication and ask the widening the
    identical question. Fifty of them bought fifty sequential scans of
    ``taggit_tag`` on an anonymous, unthrottled endpoint. The memo is keyed on
    ``tag_key``, which is the level at which they are one question.

    Asserted as a query COUNT rather than a timing, and against the same
    request with one term: it may not grow at all.
    """
    creator = creator_factory()
    for spelling in ("zero knowledge", "zero  knowledge", "zero   knowledge"):
        _page(creator, tags=[spelling], title=spelling)

    _run_normalize()

    with CaptureQueriesContext(connection) as single:
        once = api_client.get("/api/zpage/", {"tags": "zero knowledge"})
    assert once.status_code == 200, once.content
    baseline = {row["free2zaddr"] for row in once.data["results"]}
    assert len(baseline) == 3

    # Distinct spellings AND distinct casings -- every one a different string,
    # and deliberately MORE of them than the scan budget allows. A budget that
    # counted terms rather than scans would switch widening off partway
    # through and drop a page whose answer was already sitting in the memo,
    # free: the result would change at the boundary, for a request that is
    # semantically one tag repeated.
    variants = []
    for extra in range(1, 1 + LIVE_WIDENING_MAX_SCANS + 10):
        variants.append("zero" + " " * extra + "knowledge")
        variants.append("ZERO" + " " * extra + "KNOWLEDGE")
    assert len(set(variants)) == len(variants)
    assert len(variants) > LIVE_WIDENING_MAX_SCANS

    with CaptureQueriesContext(connection) as many:
        response = api_client.get("/api/zpage/", {"tags": ",".join(variants)})
    assert response.status_code == 200, response.content
    assert {row["free2zaddr"] for row in response.data["results"]} == baseline

    # One scan for the group, however many spellings asked for it. The alias
    # lookups are per-term and pre-date this change; the SCAN is what the memo
    # bounds, so count only those.
    def scans(context):
        return sum(
            1 for query in context.captured_queries
            if "taggit_tag" in query["sql"] and "~*" in query["sql"]
        )

    assert scans(single) == 1
    assert scans(many) == 1


@pytest.mark.django_db
def test_distinct_alias_groups_cannot_exceed_the_scan_budget(
    api_client, creator_factory,
):
    """The bound that has to hold when the memo cannot help.

    Many renderings of ONE group collapse to one scan; many DIFFERENT groups
    cannot. `?tags=` has no term cap and can never get one (dropping an ANDed
    term widens the result set, which is a wrong answer), so the ceiling lives
    on the scans instead. Past it, a term resolves the way it did before
     -- fewer pages, never different ones.
    """
    creator = creator_factory()
    groups = LIVE_WIDENING_MAX_SCANS + 10
    for index in range(groups):
        base = f"topic{index} alpha"
        _page(creator, tags=[base], title=base)
        _page(creator, tags=[f"topic{index}  alpha"], title=f"{base} wide")

    _run_normalize()

    terms = ",".join(f"topic{index} alpha" for index in range(groups))
    with CaptureQueriesContext(connection) as context:
        response = api_client.get("/api/zpage/", {"tags": terms})
    assert response.status_code == 200, response.content

    scans = sum(
        1 for query in context.captured_queries
        if "taggit_tag" in query["sql"] and "~*" in query["sql"]
    )
    assert scans == LIVE_WIDENING_MAX_SCANS


@pytest.mark.django_db
def test_autocomplete_shares_the_same_scan_budget(
    api_client, creator_factory,
):
    """The budget belongs to the memo, not to one caller's loop.

    ``/api/tagging/autocomplete`` walks the identical resolution loop over up
    to 50 ``selected_tags`` and resolves each term TWICE -- once to exclude
    the group, once to narrow the counted corpus. The first version of this
    bound lived in the ``?tags=`` loop and this endpoint had none at all, so
    one anonymous request bought 50 (or 100) sequential scans. Moving the
    ceiling into the cache is what makes forgetting it impossible.
    """
    creator = creator_factory()
    groups = LIVE_WIDENING_MAX_SCANS + 10
    for index in range(groups):
        base = f"topic{index} alpha"
        _page(creator, tags=[base, "privacy"], title=base)
        _page(creator, tags=[f"topic{index}  alpha"], title=f"{base} wide")

    _run_normalize()

    selected = ",".join(f"topic{index} alpha" for index in range(groups))
    with CaptureQueriesContext(connection) as context:
        response = api_client.get(
            "/api/tagging/autocomplete",
            {"type": "zpage", "selected_tags": selected},
        )
    assert response.status_code == 200, response.content

    scans = sum(
        1 for query in context.captured_queries
        if "taggit_tag" in query["sql"] and "~*" in query["sql"]
    )
    # Not `groups`, and not `2 * groups` either: the second pass over the same
    # terms reads the memo.
    assert scans == LIVE_WIDENING_MAX_SCANS


@pytest.mark.django_db
def test_autocomplete_excludes_a_case_spelling_the_alias_table_never_recorded(
    api_client, creator_factory,
):
    """The exclusion has to group tags the way the filters do.

    ``TagAlias`` records ONE row for ``Python``/``PYTHON``/``pyThon``, so
    ``resolve_alias_terms`` returns two of the three names. An exact
    ``name__in`` exclusion therefore left the third listed as an addable tag
    while it was already selected, and accepting it writes a second spelling
    of a tag the page carries. ``iexact`` groups them the way
    ``?tags=`` and the count narrowing below already did.
    """
    creator = creator_factory()
    _page(creator, tags=["Python", "privacy"], title="Canonical")
    _page(creator, tags=["PYTHON", "privacy"], title="Upper")
    _page(creator, tags=["pyThon", "privacy"], title="Mixed")

    _run_normalize()

    for spelling in ("Python", "PYTHON", "pyThon"):
        response = api_client.get(
            "/api/tagging/autocomplete",
            {"type": "zpage", "selected_tags": spelling},
        )
        assert response.status_code == 200, response.content
        offered = {row["name"] for row in json.loads(response.content)}
        assert not any(
            name.lower() == "python" for name in offered
        ), (spelling, offered)
        assert "privacy" in offered


@pytest.mark.django_db
def test_consolidation_journal_supports_exact_reversal(
    creator_factory,
):
    """The plan's ``created`` flag is what makes the docstring's reversal
    promise true for the common shape: a page that carried ONLY the variant.

    With only ``(content_type_id, object_id)`` journaled, a replay cannot
    tell whether an object already carried the canonical, so it must leave
    the canonical in place -- double-tagging every such page. Replaying the
    recorded plan here, exactly as the module docstring documents, proves
    both directions of the round trip.
    """
    canonical_page = _page(
        creator_factory(), tags=["crypto"], title="Only canonical")
    variant_page = _page(
        creator_factory(), tags=["CRYPTO"], title="Only variant")
    # Carries BOTH spellings before the run: its canonical membership
    # pre-exists, so the journal must record created=False for it -- the one
    # value that separates "added by this run" from "was already here".
    carrier = _page(creator_factory(), tags=["CRYPTO", "crypto"],
                    title="Carrier")
    comment_carrier = _comment(creator_factory(), text="Comment carrier")
    comment_carrier.tags.add("CRYPTO", "crypto")

    _run_normalize("--consolidate")

    variant_page.refresh_from_db()
    canonical_page.refresh_from_db()
    carrier.refresh_from_db()
    assert {t.name for t in variant_page.tags.all()} == {"crypto"}
    assert {t.name for t in canonical_page.tags.all()} == {"crypto"}
    assert list(carrier.tags.names()) == ["crypto"]

    # The journal itself distinguishes added from pre-existing memberships.
    run = TagNormalizationRun.objects.order_by("-started_at").first()
    group = run.plan[tag_key("crypto")]
    by_object = {
        triple[1]: triple[2] for entry in group["variants"]
        for triple in entry["moved_pairs"]
    }
    assert by_object[variant_page.pk] is True
    assert by_object[carrier.pk] is False
    assert by_object[str(comment_carrier.uuid)] is False

    # --- documented reversal: delete the run's aliases, replay its plan ---
    run = TagNormalizationRun.objects.order_by("-started_at").first()
    assert run.consolidated is True
    TagAlias.objects.all().delete()

    restored_variant = Tag.objects.create(name="CRYPTO")
    for key, group in run.plan.items():
        canonical_id = group["canonical_id"]
        for entry in group["variants"]:
            for content_type_id, object_id, created in entry["moved_pairs"]:
                model = ContentType.objects.get_for_id(
                    content_type_id).model_class()
                through = model.tags.through
                # Restore the variant membership the run removed...
                through.objects.get_or_create(
                    tag=restored_variant,
                    content_type_id=content_type_id,
                    object_id=object_id,
                )
                #...and remove the canonical membership ONLY where this run
                # added it (created=True). Pre-existing ones stay.
                if created:
                    through.objects.filter(
                        tag_id=canonical_id,
                        content_type_id=content_type_id,
                        object_id=object_id,
                    ).delete()

    variant_page.refresh_from_db()
    canonical_page.refresh_from_db()
    carrier.refresh_from_db()
    comment_carrier.refresh_from_db()
    # ONLY-VARIANT round-trips to exactly what its creator typed...
    assert {t.name for t in variant_page.tags.all()} == {"CRYPTO"}
    #...the carrier keeps its pre-existing canonical (created=False means
    # "not ours to remove") alongside the restored variant...
    assert sorted(carrier.tags.names()) == ["CRYPTO", "crypto"]
    assert sorted(comment_carrier.tags.names()) == ["CRYPTO", "crypto"]
    #...and a page that never carried the variant is untouched.
    assert {t.name for t in canonical_page.tags.all()} == {"crypto"}


@pytest.mark.django_db
def test_autocomplete_counts_widen_through_alias_and_offer_neither_spelling(
    api_client, creator_factory,
):
    """The autocomplete half of the widening contract ( review).

    The list endpoint test above pins ``GET /api/zpage/?tags=``; this pins the
    OTHER consumer of ``resolve_alias_terms``. Selecting one spelling of the
    alias group must narrow the counted corpus to the pages carrying EITHER
    spelling -- redirecting to the canonical here desynced these counts from
    the list endpoint once before  -- and neither spelling of the group
    may be offered back as addable. The shared second tag makes widening
    OBSERVABLE: a redirected term narrows to the canonical's page alone, so
    its ``privacy`` count reads 1 instead of 2.
    """
    creator = creator_factory()
    _page(creator, tags=["zero knowledge", "privacy"], title="Single spaced")
    _page(creator, tags=["zero  knowledge", "privacy"], title="Double spaced")
    _page(creator, tags=["gardening"], title="Unrelated")

    _run_normalize()

    # Either spelling of the group must reach both pages' corpus.
    for spelling in ("zero knowledge", "zero  knowledge"):
        response = api_client.get(
            "/api/tagging/autocomplete",
            {"type": "zpage", "selected_tags": spelling},
        )
        assert response.status_code == 200, response.content
        counted = {
            row["name"]: row["count"] for row in json.loads(response.content)
        }

        # WIDENING, not redirecting: the shared tag counts BOTH pages.
        assert counted.get("privacy") == 2, counted

        # And neither spelling of the fully-selected group comes back as
        # addable, on either branch.
        assert not any(name.startswith("zero") for name in counted), counted
