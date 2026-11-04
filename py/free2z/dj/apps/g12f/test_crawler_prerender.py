"""Crawler prerender tier: URL parity with SvelteKit + visibility.

nginx proxies social/preview-crawler user agents to Django, which renders a
small Open Graph card. Before this, that URLconf still described the pre-
URL scheme, so the canonical `/{username}/{vanity}` zPage URL -- every URL in
the sitemap -- 404'd, and every link shared to Twitter/X, Facebook, Slack,
Discord, WhatsApp or Telegram rendered no preview card.

Verified live on production 2026-08-07 with `curl -A Twitterbot/1.0`:

    /                       200  20875b
    /skylar                 200   2981b   works
    /skylar/zpage/skylar    200   2880b   works (legacy scheme)
    /skylar/skylar          404    179b   CANONICAL zpage URL, broken
    /creators               404    179b   swallowed by <str:username>
    /trending               404    179b   same
"""

import re
import uuid
from pathlib import Path

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.urls import Resolver404, resolve, reverse

from dj.apps.g12f.models import zPage
from dj.apps.g12f.serializers.zpage import RESERVED_VANITIES
from dj.apps.g12f.views import crawler


# Django's test-client default host; the cards build absolute URLs from
# HTTP_HOST, so every canonical/og:url assertion below is host-relative.
HOST = "testserver"

# The greedy patterns that can claim ordinary two- and three-segment paths.
# All must stay unreachable from a reserved first segment; the missing legacy
# guard once let `/api/zpage/skylar` ship an OG card to API clients.
_GREEDY_CRAWLER_VIEWS = (
    crawler.pretty_live_social,
    crawler.zpage_vanity_social,
    crawler.zpage_social_new,
)


def _page(creator, **kwargs):
    kwargs.setdefault("vanity", f"page-{uuid.uuid4().hex[:12]}")
    kwargs.setdefault("free2zaddr", str(uuid.uuid4()))
    kwargs.setdefault("title", "El Güerito del Cerrito")
    kwargs.setdefault("content", "Secret body copy that only readers get.")
    kwargs.setdefault("is_published", True)
    return zPage.objects.create(
        creator=creator,
        **kwargs,
    )


def _get(client, path):
    return client.get(path, HTTP_HOST=HOST)


def _html(response):
    return response.content.decode()


# --- the actual bug: the canonical zPage URL ------------------------------


@pytest.mark.django_db
def test_canonical_zpage_url_renders_the_open_graph_card(client, creator_factory):
    creator = creator_factory()
    page = _page(creator, description="A description of the page.")

    response = _get(client, f"/{creator.username}/{page.vanity}")

    assert response.status_code == 200
    html = _html(response)
    canonical = f"https://{HOST}/{creator.username}/{page.vanity}"
    assert f"<title>{page.title}</title>" in html
    assert f'<meta property="og:title" content="{page.title}">' in html
    assert f'<meta property="og:url" content="{canonical}">' in html
    assert f'<link rel="canonical" href="{canonical}">' in html
    assert f'<meta name="twitter:url" content="{canonical}">' in html
    assert (
        f'<meta property="og:image" content="https://{HOST}'
        f'{page.get_featured_image()}">'
    ) in html
    assert 'content="A description of the page."' in html


@pytest.mark.django_db
def test_canonical_card_points_at_the_canonical_url_not_the_legacy_one(
    client, creator_factory
):
    """og:url / canonical must match what the sitemap publishes.

    `zPage.get_url()` is still the legacy `/{u}/zpage/{v}` shape because it is
    part of the API contract; the card must not echo it or every zPage
    advertises a canonical Google never saw in the sitemap.
    """
    creator = creator_factory()
    page = _page(creator)

    html = _html(_get(client, f"/{creator.username}/{page.vanity}"))

    assert f"https://{HOST}{page.get_public_url()}" in html
    assert f"https://{HOST}{page.get_url()}" not in html
    assert "/zpage/" not in html


@pytest.mark.django_db
def test_legacy_zpage_url_still_renders(client, creator_factory):
    """Old shared links (/{username}/zpage/{slug}) must not break."""
    creator = creator_factory()
    page = _page(creator)

    response = _get(client, f"/{creator.username}/zpage/{page.vanity}")

    assert response.status_code == 200
    assert f"<title>{page.title}</title>" in _html(response)


@pytest.mark.django_db
def test_legacy_bare_zpage_url_still_renders(client, creator_factory):
    page = _page(creator_factory())

    response = _get(client, f"/zpage/{page.vanity}")

    assert response.status_code == 200
    assert f"<title>{page.title}</title>" in _html(response)


@pytest.mark.django_db
def test_zpage_resolvable_by_free2zaddr(client, creator_factory):
    """get_public_url() falls back to free2zaddr, so that URL is real too."""
    creator = creator_factory()
    page = _page(creator, vanity=None)

    response = _get(client, f"/{creator.username}/{page.free2zaddr}")

    assert response.status_code == 200
    assert f"<title>{page.title}</title>" in _html(response)


@pytest.mark.django_db
def test_free2zaddr_beats_a_vanity_squatting_on_it(client, creator_factory):
    """`vanity` is user-controlled; `free2zaddr` is the immutable identity.

    Neither column is unique against the other, so an attacker can point their
    own page's vanity at a victim page's public free2zaddr. A single
    `Q(vanity) | Q(free2zaddr)` lookup would then serve the attacker's title
    and image under the victim's canonical URL -- ideal for phishing. Same
    hazard `views/series.py` already documents (codex adversarial review).
    """
    victim = _page(creator_factory(), title="Legitimate page")
    attacker = _page(creator_factory(), title="Phishing page")
    attacker.vanity = victim.free2zaddr
    attacker.save(update_fields=["vanity"])

    html = _html(_get(client, f"/{victim.creator.username}/{victim.free2zaddr}"))

    assert "<title>Legitimate page</title>" in html
    assert "Phishing page" not in html


@pytest.mark.django_db
def test_canonical_slugified_vanity_beats_a_legacy_case_squatter(
    client, creator_factory,
):
    """Crawler resolution matches the shared canonical vanity tier."""
    _page(
        creator_factory(username="crawler-legacy-case"),
        vanity="CoolStuff",
        title="Legacy page",
    )
    canonical = _page(
        creator_factory(username="crawler-canonical-case"),
        vanity="coolstuff",
        title="Canonical page",
    )

    response = _get(client, f"/{canonical.creator.username}/COOLSTUFF")

    assert response.status_code == 200
    html = _html(response)
    assert "<title>Canonical page</title>" in html
    assert "Legacy page" not in html


@pytest.mark.django_db
def test_vanity_lookup_is_case_insensitive_but_exact_first(
    client, creator_factory
):
    """Parity with the API's `vanity__iexact`, without paying for it.

    `vanity` is unique=True, so the exact match is a unique-index probe while
    `iexact` compiles to UPPER(vanity)=UPPER(%s) and seq scans. The exact
    match must therefore resolve without the scanning query ever running
    (codex adversarial review).
    """
    creator = creator_factory()
    page = _page(creator, vanity="MixedCase", title="Case test")

    with CaptureQueriesContext(connection) as captured:
        exact = _get(client, f"/{creator.username}/MixedCase")
    assert exact.status_code == 200
    assert "<title>Case test</title>" in _html(exact)
    # The scanning form must never have run for an exact hit.
    assert not [q for q in captured.captured_queries if "UPPER(" in q["sql"]]

    #...and a differently-cased share link still resolves, as SvelteKit's
    # /api/zpage/<vanity>/ lookup does.
    folded = _get(client, f"/{creator.username}/mixedcase")
    assert folded.status_code == 200
    assert "<title>Case test</title>" in _html(folded)


@pytest.mark.django_db
def test_mismatched_username_still_renders_with_the_owners_canonical(
    client, creator_factory
):
    """The vanity is globally unique; SvelteKit 301s a wrong username here.

    A shared link with a stale username must render a card (not 404) and must
    advertise the owner's canonical URL so the duplicates collapse.
    """
    owner = creator_factory()
    other = creator_factory()
    page = _page(owner)

    response = _get(client, f"/{other.username}/{page.vanity}")

    assert response.status_code == 200
    assert f"https://{HOST}/{owner.username}/{page.vanity}" in _html(response)


# --- privacy: never more public than the page itself ----------------------


@pytest.mark.django_db
@pytest.mark.parametrize(
    "path_template",
    [
        "/{username}/{vanity}",
        "/{username}/zpage/{vanity}",
        "/zpage/{vanity}",
    ],
)
def test_unpublished_zpage_is_404_and_leaks_nothing(
    client, creator_factory, path_template
):
    creator = creator_factory()
    page = _page(
        creator,
        is_published=False,
        title="Unreleased scoop",
        content="Embargoed body copy",
        description="Embargoed description",
    )

    response = _get(
        client,
        path_template.format(username=creator.username, vanity=page.vanity),
    )

    assert response.status_code == 404
    body = _html(response)
    assert "Unreleased scoop" not in body
    assert "Embargoed body copy" not in body
    assert "Embargoed description" not in body


@pytest.mark.django_db
def test_hidden_identity_does_not_fall_through_to_a_public_vanity_squatter(
    client, creator_factory,
):
    """A hidden identity must fail closed before visible vanity lookup."""
    address = f"hidden-crawler-{uuid.uuid4().hex}"
    _page(
        creator_factory(username="crawler-public-squatter"),
        vanity=address,
        title="Public squatter page",
    )
    hidden = _page(
        creator_factory(username="crawler-hidden-identity"),
        vanity="hidden-crawler-page",
        free2zaddr=address,
        title="Hidden identity page",
        is_published=False,
    )

    response = _get(client, f"/{hidden.creator.username}/{address}")

    assert response.status_code == 404
    assert "Public squatter page" not in _html(response)


@pytest.mark.django_db
def test_nonexistent_zpage_is_404(client, creator_factory):
    creator = creator_factory()

    assert _get(client, f"/{creator.username}/no-such-page").status_code == 404


@pytest.mark.django_db
def test_subscriber_only_page_gets_a_card_but_never_its_body(
    client, creator_factory
):
    creator = creator_factory()
    page = _page(
        creator,
        is_subscriber_only=True,
        title="Members post",
        content="Paywalled body copy",
    )

    response = _get(client, f"/{creator.username}/{page.vanity}")

    assert response.status_code == 200
    html = _html(response)
    assert "<title>Members post</title>" in html
    assert "Paywalled body copy" not in html
    assert crawler.SUBSCRIBER_ONLY_DESCRIPTION in html


@pytest.mark.django_db
def test_public_page_without_a_description_still_shows_its_body(
    client, creator_factory
):
    """Guard the gating above against becoming a blanket content strip."""
    creator = creator_factory()
    page = _page(creator, content="Public body copy")

    html = _html(_get(client, f"/{creator.username}/{page.vanity}"))

    assert "Public body copy" in html


# --- every card must declare a canonical ---------------------------------
#
# The zPage card and the static-route card have carried `<link rel=canonical>`
# since. The creator profile, converse and Chat2Z cards never did -- they
# emitted `og:url` and stopped there. `og:url` is an Open Graph hint for
# unfurlers; it is not a canonical, and search engines do not read it as one.
# Verified on production 2026-08-17: `curl -A Twitterbot/1.0 /skylar` returned
# a 200 card with an `og:url` and no canonical element anywhere in the document.


@pytest.mark.django_db
def test_creator_profile_card_declares_its_canonical(client, creator_factory):
    creator = creator_factory()
    canonical = f"https://{HOST}/{creator.username}"

    html = _html(_get(client, f"/{creator.username}"))

    assert f'<link rel="canonical" href="{canonical}">' in html
    # Same URL the card already advertises to unfurlers -- the two must not
    # be able to drift apart.
    assert f'<meta property="og:url" content="{canonical}">' in html


@pytest.mark.django_db
def test_creator_profile_canonical_uses_the_stored_case_not_the_requested_one(
    client, creator_factory
):
    """`/Skylar` and `/skylar` are one page and must declare one canonical.

    The lookup is case-insensitive, so without this the card would happily
    self-canonicalise whatever spelling the crawler happened to ask for and
    mint a duplicate per casing.
    """
    creator = creator_factory()
    swapped = creator.username.swapcase()
    assert swapped != creator.username, "factory produced a caseless username"

    html = _html(_get(client, f"/{swapped}"))

    assert f'<link rel="canonical" href="https://{HOST}/{creator.username}">' in html
    assert f"https://{HOST}/{swapped}" not in html


# A card may legitimately have an `og:url` and NO canonical, but only when the
# URL it names is not a document we want indexed. `og:url` is a weak hint an
# unfurler uses to label a preview; a canonical is an authoritative claim that
# the URL IS the document. Pointing one at a retired route is worse than
# omitting it, so these are exemptions with reasons rather than a blanket rule.
#
# openai/social.html: `Conversation.get_url()` is a documented split-brain URL
# -- it resolves in classic and answers 410 Gone in SvelteKit
# (ts/svelte/free2z/src/routes/ai/conversation/[...rest]/+page.server.ts), and
# the model comment says in as many words not to publish it anywhere new.
# Confirmed against production 2026-08-17: Googlebot gets 410 for
# /ai/conversation/<uuid> while the card tier answers 200. Declaring a
# canonical there would tell a crawler "this is the authoritative document"
# about a URL the search-facing tier calls permanently deleted. It goes away
# with the route in  phase 4. (Raised by the codex adversarial review.)
# comments/social.html: `/converse/<uuid>` is NOT one URL per document. The
# SvelteKit loader walks `parent` up to the root comment and renders the root
# thread, focusing the requested one
# (ts/svelte/free2z/src/routes/converse/[uuid]/+page.server.ts), so every reply
# in a thread renders substantially the same page. A self-referential canonical
# built from `comment.get_url` would therefore assert that each reply UUID is
# its own canonical document and manufacture exactly the duplicate cluster this
# work exists to remove. The right canonical is the ROOT thread's URL, which
# needs the parent walk on the Django side too -- more than a template change,
# and the SvelteKit page emits no canonical for these either. Tracked in.
# (Both raised by the codex adversarial review.)
_CARDS_WITHOUT_A_CANONICAL_ON_PURPOSE = {
    "templates/openai/social.html": "target answers 410 Gone in SvelteKit",
    "templates/comments/social.html": "replies resolve to their root thread",
}


# Django comments are stripped before matching, so a template that merely
# *mentions* `rel="canonical"` in a `{#... #}` note -- as creator/social.html
# does two lines above the real tag -- cannot satisfy the invariant by talking
# about it. Both patterns tolerate single or double quotes and extra
# whitespace, so a stylistic reformat does not silently exempt a card.
# (Substring fragility raised by the codex adversarial review.)
_DJANGO_COMMENT_RE = re.compile(
    r"\{#.*?#\}|\{%\s*comment\s*%\}.*?\{%\s*endcomment\s*%\}", re.S
)
_OG_URL_RE = re.compile(r"""property\s*=\s*['"]og:url['"]""")
_CANONICAL_RE = re.compile(r"""rel\s*=\s*['"]canonical['"]""")


def test_every_card_template_that_has_an_og_url_also_has_a_canonical():
    """Structural invariant, so a new card cannot ship without one.

    No DB and no client: this reads the template sources, which is the point
    -- it catches a template added for a route no test exercises yet.
    """
    templates = (Path(__file__).parent / "templates").rglob("*.html")
    missing = []
    for template in sorted(templates):
        name = str(template.relative_to(Path(__file__).parent))
        source = _DJANGO_COMMENT_RE.sub("", template.read_text())
        if not _OG_URL_RE.search(source):
            continue
        if _CANONICAL_RE.search(source):
            assert name not in _CARDS_WITHOUT_A_CANONICAL_ON_PURPOSE, (
                f"{name} now has a canonical -- drop its exemption"
            )
            continue
        if name in _CARDS_WITHOUT_A_CANONICAL_ON_PURPOSE:
            continue
        missing.append(name)

    assert not missing, f"card templates with og:url but no canonical: {missing}"


@pytest.mark.django_db
def test_inactive_creator_profile_is_404(client, creator_factory):
    creator = creator_factory()
    creator.is_active = False
    creator.save(update_fields=["is_active"])

    assert _get(client, f"/{creator.username}").status_code == 404
    assert _get(client, f"/creator/{creator.username}").status_code == 404


@pytest.mark.django_db
def test_deactivating_a_creator_also_pulls_their_zpage_cards(
    client, creator_factory
):
    """Deactivation is the moderation lever; it does not unpublish pages.

    Without creator__is_active on the zPage lookup a banned account's profile
    404s while every one of its pages keeps serving a card with full body copy
    (codex adversarial review, ).
    """
    creator = creator_factory()
    page = _page(creator, title="Banned content", content="Banned body copy")
    assert _get(client, f"/{creator.username}/{page.vanity}").status_code == 200

    creator.is_active = False
    creator.save(update_fields=["is_active"])

    for path in (
        f"/{creator.username}/{page.vanity}",
        f"/{creator.username}/zpage/{page.vanity}",
        f"/zpage/{page.vanity}",
    ):
        response = _get(client, path)
        assert response.status_code == 404, path
        assert "Banned body copy" not in _html(response)

    #...and the homepage must stop linking it.
    assert "Banned content" not in _html(_get(client, "/"))


@pytest.mark.django_db
def test_card_never_renders_the_whole_body(client, creator_factory):
    """`content` is a 100,000-char field on a single sync gunicorn worker.

    The old description fallback markdown-rendered all of it and interpolated
    the result into four meta attributes (codex adversarial review, ).
    """
    creator = creator_factory()
    page = _page(creator, content="A" * 90_000 + "TAIL-MARKER")

    html = _html(_get(client, f"/{creator.username}/{page.vanity}"))

    assert "TAIL-MARKER" not in html
    assert len(html) < 20_000
    assert "<p>" not in html  # no markdown2 render of the body


# --- static routes the greedy <str:username> pattern used to swallow ------


@pytest.mark.django_db
@pytest.mark.parametrize("route", sorted(crawler.STATIC_ROUTES))
def test_static_routes_do_not_404(client, route):
    response = _get(client, f"/{route}")

    assert response.status_code == 200, route
    html = _html(response)
    title, description, robots = crawler.STATIC_ROUTES[route]
    assert f"<title>{title}</title>" in html
    assert f'<meta property="og:url" content="https://{HOST}/{route}" />' in html
    assert f'<link rel="canonical" href="https://{HOST}/{route}">' in html
    if robots:
        assert f'<meta name="robots" content="{robots}" />' in html
    else:
        assert 'name="robots"' not in html


@pytest.mark.django_db
def test_creators_and_trending_render_their_own_cards(client):
    """The two headline regressions from the issue."""
    creators = _html(_get(client, "/creators"))
    trending = _html(_get(client, "/trending"))

    assert "Creator directory" in creators
    assert "Trending on Free2Z" in trending
    assert creators != trending


@pytest.mark.django_db
def test_private_surfaces_are_served_but_never_indexable(client):
    for route in ("login", "edit", "buy-2z", "reset-password"):
        html = _html(_get(client, f"/{route}"))
        assert f'content="{crawler.NOINDEX}"' in html, route


@pytest.mark.django_db
def test_a_static_route_wins_over_a_creator_of_the_same_name(
    client, creator_factory
):
    """SvelteKit resolves a literal segment before [username]; so must this.

    The direct model factory creates a grandfathered row; registration rejects
    `trending` now, but existing URLs must keep their SvelteKit semantics.
    """
    creator_factory(username="trending")

    assert "Trending on Free2Z" in _html(_get(client, "/trending"))


@pytest.mark.django_db
def test_unknown_top_level_name_is_still_an_honest_404(client):
    assert _get(client, "/definitely-not-a-creator").status_code == 404


# --- parameterised sub-routes --------------------------------------------


@pytest.mark.django_db
def test_live_route_canonicalises_to_the_pretty_broadcast_url(
    client, creator_factory
):
    """`/live/{u}` is an ALIAS; it must not declare itself canonical.

    It used to, while SvelteKit SSR declared `/{u}/broadcast` for the very
    same URL -- two tiers, two contradictory canonicals, which is the
    disagreement  is about.
    """
    creator = creator_factory(full_name="Skylar S")

    response = _get(client, f"/live/{creator.username}")

    assert response.status_code == 200
    html = _html(response)
    canonical = f"https://{HOST}/{creator.username}/broadcast"
    assert "Skylar S is live on Free2Z" in html
    assert f'<link rel="canonical" href="{canonical}">' in html
    assert f'<meta property="og:url" content="{canonical}" />' in html
    assert f"https://{HOST}/live/{creator.username}" not in html


@pytest.mark.django_db
@pytest.mark.parametrize(
    "stream_type", ["broadcast", "ppv", "subscribers-only"]
)
def test_live_alias_honours_the_type_query_parameter(
    client, creator_factory, stream_type
):
    """`?type=` selects WHICH stream the alias means, as SvelteKit does.

    Without this, `/live/x?type=ppv` unfurled under a canonical naming a
    different stream.
    """
    creator = creator_factory()

    response = _get(client, f"/live/{creator.username}?type={stream_type}")

    assert response.status_code == 200
    canonical = f"https://{HOST}/{creator.username}/{stream_type}"
    assert f'<link rel="canonical" href="{canonical}">' in _html(response)


@pytest.mark.django_db
@pytest.mark.parametrize("value", ["private", "nonsense", "BROADCAST!"])
def test_live_alias_404s_a_type_outside_the_public_enum(
    client, creator_factory, value
):
    """SvelteKit 404s these; a card for a URL that 404s on click is worse
    than no card. `private` is not a viewer URL at all."""
    creator = creator_factory()

    assert _get(
        client, f"/live/{creator.username}?type={value}"
    ).status_code == 404


@pytest.mark.django_db
def test_live_alias_with_an_empty_type_falls_back_to_broadcast(
    client, creator_factory
):
    """Mirrors `(routeType || searchParams.get("type") || "broadcast")`."""
    creator = creator_factory()

    response = _get(client, f"/live/{creator.username}?type=")

    assert response.status_code == 200
    assert (
        f'<link rel="canonical" href="https://{HOST}/{creator.username}'
        '/broadcast">'
    ) in _html(response)


@pytest.mark.django_db
@pytest.mark.parametrize(
    "query, expected",
    [
        # QueryDict.get() reads the LAST value; URLSearchParams.get() reads the
        # FIRST. Both tiers must read the same one or the same URL gets two
        # different canonicals -- and, on the second case, one tier 404s a URL
        # the other renders (codex adversarial review).
        ("type=ppv&type=broadcast", "ppv"),
        ("type=broadcast&type=ppv", "broadcast"),
    ],
)
def test_live_alias_reads_the_first_repeated_type_like_sveltekit(
    client, creator_factory, query, expected
):
    creator = creator_factory()

    response = _get(client, f"/live/{creator.username}?{query}")

    assert response.status_code == 200
    assert (
        f'<link rel="canonical" href="https://{HOST}/{creator.username}'
        f'/{expected}">'
    ) in _html(response)


@pytest.mark.django_db
def test_live_alias_404s_when_the_first_repeated_type_is_invalid(
    client, creator_factory
):
    """SvelteKit reads `private` first here and 404s; so must this tier."""
    creator = creator_factory()

    assert _get(
        client, f"/live/{creator.username}?type=private&type=broadcast"
    ).status_code == 404


@pytest.mark.django_db
def test_live_route_for_an_unknown_creator_is_404(client):
    assert _get(client, "/live/nobody").status_code == 404


@pytest.mark.django_db
@pytest.mark.parametrize("stream_type", ["broadcast", "ppv", "subscribers-only"])
def test_pretty_live_routes_render_their_canonical_cards(
    client, creator_factory, stream_type
):
    creator = creator_factory(full_name="Skylar S")

    response = _get(client, f"/{creator.username}/{stream_type}")

    assert response.status_code == 200
    html = _html(response)
    canonical = f"https://{HOST}/{creator.username}/{stream_type}"
    assert "Skylar S is live on Free2Z" in html
    assert f'<meta property="og:url" content="{canonical}" />' in html
    assert f'<link rel="canonical" href="{canonical}">' in html
    assert resolve(f"/{creator.username}/{stream_type}").func is (
        crawler.pretty_live_social
    )


@pytest.mark.django_db
@pytest.mark.parametrize(
    "path_template",
    [
        "/live/{u}",
        "/live/{u}?type=ppv",
        "/{u}/broadcast",
        "/{u}/ppv",
        "/{u}/subscribers-only",
    ],
)
def test_every_live_viewer_url_is_noindex_follow(
    client, creator_factory, path_template
):
    """336 creators x 4 near-empty, ephemeral viewer URLs is 1,344 thin pages.

    A canonical alone would only have collapsed them onto one equally thin
    page. `follow` keeps the equity flowing to `/{username}`, which IS in the
    sitemap.
    """
    creator = creator_factory()

    response = _get(client, path_template.format(u=creator.username))

    assert response.status_code == 200
    assert (
        f'<meta name="robots" content="{crawler.NOINDEX_FOLLOW}" />'
        in _html(response)
    )


@pytest.mark.django_db
@pytest.mark.parametrize(
    "path_template", ["/live/{u}", "/{u}/broadcast", "/{u}/ppv"]
)
def test_live_urls_canonicalise_to_the_stored_username_casing(
    client, creator_factory, path_template
):
    """`/SkYlAr/broadcast` and `/skylar/broadcast` are ONE page."""
    creator = creator_factory()

    response = _get(client, path_template.format(u=creator.username.upper()))

    assert response.status_code == 200
    assert f'href="https://{HOST}/{creator.username}/' in _html(response)


@pytest.mark.django_db
@pytest.mark.parametrize("stream_type", ["broadcast", "ppv", "subscribers-only"])
def test_pretty_live_routes_for_an_unknown_creator_are_404(client, stream_type):
    assert _get(client, f"/nobody/{stream_type}").status_code == 404


@pytest.mark.django_db
def test_live_route_is_not_mistaken_for_a_zpage(client, creator_factory):
    """A zPage with vanity "nobody" must not answer /live/nobody."""
    creator = creator_factory()
    _page(creator, vanity="nobody", title="Not a live stream")

    assert _get(client, "/live/nobody").status_code == 404


@pytest.mark.django_db
def test_article_route_previews_the_immutable_collision_escape(
    client, creator_factory,
):
    """The canonical fallback shared by cards must also unfurl for crawlers."""
    page = _page(creator_factory(), title="Collision-safe article")

    response = _get(client, f"/article/{page.free2zaddr}")

    assert response.status_code == 200
    html = _html(response)
    assert "<title>Collision-safe article</title>" in html
    assert f'https://{HOST}{page.get_public_url()}' in html


@pytest.mark.django_db
def test_article_route_metadata_keeps_the_collision_escape_canonical(
    client, creator_factory,
):
    page = _page(
        creator_factory(username="api"),
        vanity="launch",
        free2zaddr="collision-safe-address",
        title="Namespaced article",
    )

    html = _html(_get(client, "/article/collision-safe-address"))
    canonical = f"https://{HOST}/article/collision-safe-address"

    assert f'<link rel="canonical" href="{canonical}">' in html
    assert f'<meta property="og:url" content="{canonical}">' in html
    assert f'<meta name="twitter:url" content="{canonical}">' in html


@pytest.mark.django_db
def test_article_route_accepts_a_reserved_immutable_identity(
    client, creator_factory,
):
    page = _page(
        creator_factory(),
        vanity="broadcast",
        free2zaddr="ppv",
        title="Reserved identity article",
    )

    response = _get(client, "/article/ppv")

    assert response.status_code == 200
    html = _html(response)
    assert "<title>Reserved identity article</title>" in html
    assert f'https://{HOST}/article/ppv' in html


@pytest.mark.django_db
def test_article_route_keeps_immutable_identity_ahead_of_squatting_vanity(
    client, creator_factory,
):
    victim = _page(creator_factory(), title="Immutable article")
    attacker = _page(creator_factory(), title="Vanity squatter")
    attacker.vanity = victim.free2zaddr
    attacker.save(update_fields=["vanity"])

    html = _html(_get(client, f"/article/{victim.free2zaddr}"))

    assert "<title>Immutable article</title>" in html
    assert "Vanity squatter" not in html


@pytest.mark.django_db
def test_declined_literal_two_segment_routes_are_404_not_a_stranger_page(
    client, creator_factory
):
    """`/converse/<not-a-uuid>` must not be read as {username}/{vanity}.

    SvelteKit does not fall back to `[username]/[vanity]` once a literal
    two-segment route matches, so neither may we; the greedy pattern used to
    pick these up and answer with whatever page owned that vanity (codex
    adversarial review).
    """
    _page(creator_factory(), vanity="not-a-uuid", title="Unrelated page")

    for path in (
        "/converse/not-a-uuid",
        "/ai/conversation/not-a-uuid",
        "/live/not-a-uuid",
    ):
        response = _get(client, path)
        assert response.status_code == 404, path
        assert "Unrelated page" not in _html(response), path


@pytest.mark.django_db
def test_one_segment_static_routes_do_not_reserve_their_descendants(
    client, creator_factory
):
    """`/trending/<vanity>` is a REAL served URL in SvelteKit.

    `trending`, `creators`, `search` etc. are one-segment routes; SvelteKit
    resolves anything below them through `[username]/[vanity]`, which keys on
    the globally unique vanity alone and 301s to the owner. An earlier
    revision of this branch blanket-rejected them, which would have killed
    previews for every page of a creator holding a name FORBIDDEN_USERNAMES
    does not cover -- `trending` is exactly such a name (codex adversarial
    review).
    """
    owner = creator_factory()
    page = _page(owner, title="A real shared page")

    for prefix in ("trending", "creators", "search", "login", "edit"):
        response = _get(client, f"/{prefix}/{page.vanity}")
        assert response.status_code == 200, prefix
        html = _html(response)
        assert "<title>A real shared page</title>" in html, prefix
        #...and it collapses onto the owner's canonical, as SvelteKit's 301
        # would.
        assert f"https://{HOST}/{owner.username}/{page.vanity}" in html, prefix


@pytest.mark.django_db
def test_literal_two_segment_prefixes_do_not_block_the_legacy_three_segment_shape(
    client, creator_factory
):
    """`/live/zpage/<slug>` is `{username}/zpage/{slug}`, not `live/[username]`.

    A literal two-segment route cannot match a three-segment path, so the
    legacy guard must exclude only the non-HTML surfaces.
    """
    page = _page(creator_factory(), title="Still previewable")

    for prefix in ("live", "trending", "converse"):
        response = _get(client, f"/{prefix}/zpage/{page.vanity}")
        assert response.status_code == 200, prefix
        assert "<title>Still previewable</title>" in _html(response), prefix

    #...but the non-HTML surfaces stay blocked in that shape.
    blocked = _get(client, f"/api/zpage/{page.vanity}")
    assert blocked.status_code == 301
    assert "Still previewable" not in _html(blocked)


@pytest.mark.django_db
def test_sitemap_prefix_does_not_block_a_real_page(client, creator_factory):
    """`/sitemap/<vanity>` remains an ordinary page URL.

    SvelteKit's only two-segment sitemap route is the literal
    `sitemap/static.xml`, which never reaches this tier. New creator
    usernames are reserved separately, but this valid page shape must remain
    available to existing creators (codex adversarial review).
    """
    page = _page(creator_factory(), title="Not a sitemap")

    response = _get(client, f"/sitemap/{page.vanity}")

    assert response.status_code == 200
    assert "<title>Not a sitemap</title>" in _html(response)


@pytest.mark.django_db
def test_legacy_creator_route_resolves_the_vanity_first(
    client, creator_factory
):
    """`/creator/<x>` must open the same object a human's click opens.

    SvelteKit has no `creator/` route, so `/creator/alice` is
    `{username}="creator"` / `{vanity}="alice"` over there. Existing rows can
    still hold that name, so get_public_url() mints `/creator/{vanity}` as
    their pages' canonical. Resolving the profile
    first would let that account publish a page whose vanity is a trusted
    creator's username -- the card would show the trusted creator while the
    click opened the attacker's page (codex adversarial review).
    """
    creator_factory(username="alice", full_name="Alice The Trusted")
    attacker = creator_factory(username="creator")
    page = _page(attacker, vanity="alice", title="Attacker page")

    html = _html(_get(client, "/creator/alice"))

    assert "<title>Attacker page</title>" in html
    assert "Alice The Trusted" not in html
    #...and it advertises the page's real canonical, not the profile URL.
    assert f"https://{HOST}/creator/{page.vanity}" in html


@pytest.mark.django_db
def test_legacy_creator_route_still_serves_profiles(client, creator_factory):
    """The common case: no zPage owns that vanity, so the profile wins."""
    creator = creator_factory(full_name="Skylar S")

    response = _get(client, f"/creator/{creator.username}")

    assert response.status_code == 200
    assert "<title>Skylar S</title>" in _html(response)

    assert _get(client, "/creator/nobody").status_code == 404


@pytest.mark.django_db
def test_a_creator_named_trending_keeps_their_page_previews(
    client, creator_factory
):
    """The concrete case: `trending` is registrable and someone may hold it."""
    creator = creator_factory(username="trending")
    page = _page(creator, title="Launch announcement")

    response = _get(client, f"/trending/{page.vanity}")

    assert response.status_code == 200
    assert "<title>Launch announcement</title>" in _html(response)

    # The bare one-segment route still belongs to the static page.
    assert "Trending on Free2Z" in _html(_get(client, "/trending"))


@pytest.mark.parametrize("user_agent", ["Mozilla/5.0", "Twitterbot/1.0"])
def test_unimplemented_project_is_not_found_without_fabricated_metadata(client, user_agent):
    slug = "does-not-exist-project-1475"
    response = client.get(f"/projects/{slug}", HTTP_HOST=HOST, HTTP_USER_AGENT=user_agent)
    assert response.status_code == 404
    html = _html(response)
    assert f"Project {slug}" not in html
    assert f"View project {slug}" not in html
    assert 'rel="canonical"' not in html
    assert 'property="og:' not in html
    assert 'name="twitter:' not in html


@pytest.mark.django_db
def test_checkout_route_is_noindex(client):
    html = _html(_get(client, "/checkout/abc123"))

    assert f'content="{crawler.NOINDEX}"' in html


@pytest.mark.django_db
def test_reserved_sub_routes_404_and_never_resolve_to_someones_zpage(
    client, creator_factory
):
    """SvelteKit has no bare +page for dashboard/private/zpage: they 404.

    The reason for naming them is that the greedy pattern must not answer
    /alice/dashboard with whatever unrelated page owns the vanity
    "dashboard" (codex adversarial review, ).
    """
    creator = creator_factory()
    owner = creator_factory()
    _page(owner, vanity="dashboard", title="A page called dashboard")

    for reserved in ("dashboard", "private", "zpage"):
        response = _get(client, f"/{creator.username}/{reserved}")
        assert response.status_code == 404, reserved
        assert "A page called dashboard" not in _html(response)

    assert _get(client, "/nobody/dashboard").status_code == 404


# --- the greedy patterns must not shadow anything -------------------------


def test_api_stream_shape_does_not_resolve_to_the_crawler_tier():
    with pytest.raises(Resolver404):
        resolve("/api/broadcast")


@pytest.mark.parametrize("prefix", sorted(crawler.RESERVED_FIRST_SEGMENTS))
def test_reserved_first_segments_never_reach_a_greedy_pattern(prefix):
    """None of these is a username, so no catch-all may claim them.

    Each has a more specific pattern above it; when that pattern declines (for
    example, a non-UUID /converse/x) the request must 404, not be reinterpreted
    as {username}/{vanity}. /article/<identifier> deliberately accepts any
    zPage identifier and is still a dedicated non-greedy route.

    The three-segment `/{x}/zpage/{y}` shape is probed too, but only for the
    non-HTML surfaces: it originally had no lookahead at all, and
    `/api/zpage/skylar` served an OG card with 200 text/html to ordinary API
    clients in production. A literal TWO-segment route cannot match a
    three-segment path, so `/live/zpage/<slug>` really is
    `{username}/zpage/{slug}` -- to SvelteKit as well as to us.
    """
    if prefix in crawler.VANITY_FALLBACK_PREFIXES:
        # `creator` and `zpage` have dedicated views that deliberately DO a
        # vanity lookup, so this assertion would pass for the wrong reason.
        # test_vanity_fallback_prefixes_really_fall_back covers them instead.
        pytest.skip(f"/{prefix}/<x> resolves to a dedicated vanity-first view")

    paths = [f"/{prefix}/some-unmatched-segment"]
    if prefix in crawler.NON_CRAWLER_PREFIXES:
        paths.append(f"/{prefix}/zpage/some-unmatched-segment")

    for path in paths:
        try:
            matched = resolve(path).func
        except Resolver404:
            matched = None
        assert matched not in _GREEDY_CRAWLER_VIEWS, (prefix, path)


@pytest.mark.django_db
@pytest.mark.parametrize("prefix", sorted(crawler.NON_CRAWLER_PREFIXES))
def test_non_html_prefixes_never_render_a_social_card(
    client, creator_factory, prefix
):
    """Django keeps trying later patterns when an include() resolves nothing.

    So `/api/<unmatched>` and `/api/zpage/<unmatched>` really do reach the
    greedy zPage patterns. They must stay honest 404s rather than answer an
    API URL with 200 text/html and an OG card -- `location /api` proxies to
    Django for EVERY user agent, so this is not a crawler-only surface.
    """
    _page(creator_factory(), vanity="unmatched", title="Should not appear")

    for path in (f"/{prefix}/unmatched", f"/{prefix}/zpage/unmatched"):
        response = _get(client, path)

        # 404 for most; /adminzzz and /uploadz are claimed by earlier patterns
        # (admin login redirect, uploadz bucket redirect) and never get here.
        assert response.status_code in (301, 302, 404), (
            path, response.status_code
        )
        assert "Should not appear" not in _html(response), path

    # And they must not even *resolve* to a crawler view. /api/healthz is
    # served by middleware and dj.apps.health asserts it is unresolvable, so a
    # runtime-only guard would not be enough -- it would also defeat
    # APPEND_SLASH for a client that drops the router's trailing slash.
    # (/adminzzz and /uploadz do resolve -- to the admin and the uploadz
    # redirect, not to a card.)
    for path in (
        f"/{prefix}/unmatched-and-unrouted",
        f"/{prefix}/zpage/unmatched-and-unrouted",
    ):
        try:
            matched = resolve(path).func
        except Resolver404:
            matched = None
        assert matched not in _GREEDY_CRAWLER_VIEWS, (prefix, path)


@pytest.mark.django_db
def test_api_zpage_without_a_trailing_slash_is_not_an_html_card(
    client, creator_factory
):
    """The exact production symptom, reproduced.

    The router's detail route is `/api/zpage/<pk>/`. A client that drops the
    trailing slash used to get 200 text/html with an OG card, because
    `/{username}/zpage/{slug}` resolved with `username="api"` -- and
    APPEND_SLASH could not rescue it, since CommonMiddleware only redirects
    when the URL does NOT resolve. With the lookahead it does not resolve, so
    the client is redirected to the real JSON endpoint instead.
    """
    creator = creator_factory()
    page = _page(creator, title="Encourage Skylar")

    response = _get(client, f"/api/zpage/{page.vanity}")

    assert response.status_code == 301, response.status_code
    assert response["Location"] == f"/api/zpage/{page.vanity}/"
    assert "Encourage Skylar" not in _html(response)

    # Same for /feeds, which also proxies to Django for every user agent.
    feeds = _get(client, f"/feeds/zpage/{page.vanity}")
    assert feeds.status_code in (301, 404), feeds.status_code
    assert "Encourage Skylar" not in _html(feeds)


@pytest.mark.django_db
def test_uppercase_reserved_prefix_is_404_not_a_card(client, creator_factory):
    """The regex guard is case-sensitive like Django's own `path('api/...')`.

    `/API/x` therefore really does reach the crawler pattern; the view's
    case-insensitive re-check is what keeps it honest.
    """
    _page(creator_factory(), vanity="unmatched", title="Should not appear")

    for path in ("/API/unmatched", "/API/zpage/unmatched"):
        response = _get(client, path)

        assert response.status_code == 404, path
        assert "Should not appear" not in _html(response), path


def test_crawler_patterns_are_last_in_the_urlconf():
    """A greedy pattern above /api or /adminzzz would swallow the whole site."""
    from dj.free2z import urls as urlconf

    patterns = [str(p.pattern) for p in urlconf.urlpatterns]
    two_segment = patterns.index(crawler.ZPAGE_VANITY_ROUTE)
    one_segment = patterns.index("<str:username>")
    legacy = patterns.index(crawler.ZPAGE_LEGACY_ROUTE)

    for prefix in ("api/", "adminzzz/", "feeds/", "uploads/auth"):
        first = next(i for i, p in enumerate(patterns) if p.startswith(prefix))
        assert first < one_segment, prefix
        assert first < two_segment, prefix
        assert first < legacy, prefix

    # `/` is the documented final fallback.
    assert patterns[-1] == ""
    assert two_segment == len(patterns) - 2


def test_named_crawler_routes_resolve_to_the_crawler_views():
    assert reverse(
        "zpage_social_vanity", args=["skylar", "hello"]
    ) == "/skylar/hello"
    assert reverse(
        "zpage_social_new", args=["skylar", "hello"]
    ) == "/skylar/zpage/hello"
    assert resolve("/skylar/hello").func is crawler.zpage_vanity_social
    assert resolve("/skylar").func is crawler.creator_social_root


def test_two_segment_prefixes_are_reserved():
    """Every literal two-segment prefix is reserved for new usernames.

    `LITERAL_TWO_SEGMENT_PREFIXES` blocks the `{username}/{vanity}` fallback.
    Existing `creator`/`zpage` rows remain reachable through their dedicated
    vanity-first views; that backwards-compatibility behavior is tested below.
    This assertion makes a new literal route fail loudly unless its namespace
    is reserved in the same change.
    """
    assert crawler.UNRESERVED_TWO_SEGMENT_PREFIXES == frozenset()


@pytest.mark.django_db
@pytest.mark.parametrize(
    "prefix", sorted(crawler.VANITY_FALLBACK_PREFIXES)
)
def test_vanity_fallback_prefixes_really_fall_back(
    client, creator_factory, prefix
):
    """Reserved names remain reachable for grandfathered accounts."""
    page = _page(creator_factory(), title="Reachable either way")

    response = _get(client, f"/{prefix}/{page.vanity}")

    assert response.status_code == 200, prefix
    assert "<title>Reachable either way</title>" in _html(response), prefix


@pytest.mark.django_db
def test_legacy_creator_route_404s_a_reserved_sub_route_name(
    client, creator_factory
):
    """`/creator/dashboard` 404s in the browser, so it gets no card.

    SvelteKit matches its literal `[username]/dashboard` route ahead of
    `[vanity]`, and that route has no bare `+page`. Neither the vanity lookup
    NOR the profile fallback may answer it -- the profile fallback is why this
    needs its own guard and not just the one inside the shared lookup.
    """
    owner = creator_factory()
    _page(owner, vanity="dashboard", title="A page called dashboard")
    creator_factory(username="dashboard", full_name="Dashboard The Creator")

    response = _get(client, "/creator/dashboard")

    assert response.status_code == 404
    html = _html(response)
    assert "A page called dashboard" not in html
    assert "Dashboard The Creator" not in html


@pytest.mark.django_db
@pytest.mark.parametrize("reserved", sorted(RESERVED_VANITIES))
def test_reserved_vanities_never_render_zpage_cards(
    client, creator_factory, reserved
):
    """One guard, every vanity caller; dedicated stream routes stay valid."""
    owner = creator_factory()
    _page(owner, vanity=reserved, title="Should never be carded")

    paths = {
        f"/{owner.username}/{reserved}": (
            200
            if reserved in {"broadcast", "ppv", "subscribers-only"}
            else 404
        ),
        f"/{owner.username}/zpage/{reserved}": 404,
        f"/zpage/{reserved}": 404,
        f"/creator/{reserved}": 404,
    }
    for path, expected_status in paths.items():
        response = _get(client, path)
        assert response.status_code == expected_status, path
        assert "Should never be carded" not in _html(response), path


def test_every_crawler_namespace_is_reserved():
    """Route additions must update username reservations in the same change."""
    assert crawler.UNRESERVED_STATIC_ROUTES == frozenset()
    assert crawler.UNRESERVED_NON_CRAWLER_PREFIXES == frozenset()


@pytest.mark.django_db
def test_homepage_card_has_a_title(client, creator_factory):
    """`/` rendered `<title></title>`: the template read an unset variable."""
    _page(creator_factory(), title="Top page")

    html = _html(_get(client, "/"))

    assert f"<title>{crawler.SITE_TITLE}</title>" in html
    assert "<title></title>" not in html


@pytest.mark.django_db
def test_homepage_links_use_canonical_zpage_urls(client, creator_factory):
    creator = creator_factory()
    page = _page(creator, f2z_score=5)

    html = _html(_get(client, "/"))

    assert f'href="/{creator.username}/{page.vanity}"' in html
    assert "/zpage/" not in html


@pytest.mark.django_db
def test_homepage_listing_does_not_select_zpage_content(
    client, creator_factory
):
    """The 100-row crawler listing must not pull 100,000-char bodies."""
    _page(creator_factory(), content="x" * 100_000, f2z_score=5)

    with CaptureQueriesContext(connection) as captured:
        response = _get(client, "/")

    assert response.status_code == 200
    listing_queries = [
        query["sql"]
        for query in captured.captured_queries
        if 'FROM "g12f_zpage"' in query["sql"]
    ]
    assert listing_queries
    assert all('"g12f_zpage"."content"' not in sql for sql in listing_queries)


@pytest.mark.django_db
def test_public_crawler_detail_defers_full_content_for_the_card_excerpt(
    creator_factory,
):
    """Detail cards fetch only the bounded prefix used by the crawler."""
    content = "x" * 100_000
    page = _page(creator_factory(), content=content)

    with CaptureQueriesContext(connection) as captured:
        zpage = crawler._published_zpage_or_404(page.vanity)
        query_count = len(captured.captured_queries)
        assert "content" in zpage.get_deferred_fields()
        assert zpage.card_content == content[:crawler.CARD_BODY_CHARS]
        assert len(captured.captured_queries) == query_count


@pytest.mark.django_db
def test_partial_public_page_never_loads_deferred_card_fields(creator_factory):
    """A partial caller fails closed without fetching body or gate state."""
    page = _page(creator_factory(), content="x" * 100_000)
    zpage = zPage.objects.only("pk").get(pk=page.pk)
    assert {"content", "is_subscriber_only"}.issubset(
        zpage.get_deferred_fields()
    )
    assert "card_content" not in zpage.__dict__

    with CaptureQueriesContext(connection) as captured:
        assert crawler._card_content(zpage) == ""

    assert captured.captured_queries == []

    # Even a supplied annotation is unsafe without loaded visibility state.
    zpage.__dict__["card_content"] = "must not render"
    with CaptureQueriesContext(connection) as captured:
        assert crawler._card_content(zpage) == ""

    assert captured.captured_queries == []


@pytest.mark.django_db
def test_subscriber_only_detail_never_loads_a_body_excerpt(creator_factory):
    """Paywalled body copy must not enter the crawler view process at all."""
    page = _page(
        creator_factory(),
        content="Paywalled body copy",
        is_subscriber_only=True,
    )

    with CaptureQueriesContext(connection) as captured:
        zpage = crawler._published_zpage_or_404(page.vanity)
        query_count = len(captured.captured_queries)
        assert "content" in zpage.get_deferred_fields()
        assert zpage.card_content == ""
        assert crawler._card_content(zpage) == ""
        assert len(captured.captured_queries) == query_count


# --- trailing slashes: the shape a shared link actually carries  ----
#
# Every pattern in the crawler block is slashless. `/{username}/` and the
# canonical `/{username}/{vanity}/` therefore matched NOTHING on this tier and
# 404'd, while SvelteKit 308s the same URL to its slashless form for humans and
# for search crawlers -- so the failure was invisible in a browser and in
# Search Console, and visible only as a "not found" unfurl card. Measured on
# production 2026-09-03 with `-A facebookexternalhit/1.1`, before the fix:
#
#     /free2z                    200      /free2z/                    404
#     /free2z/flavored-markdown  200      /free2z/flavored-markdown/  404
#     /find /creators /trending  200      each of those with a slash  404
#     /creator/x /live/x /zpage/x 200...and each of those        404


@pytest.mark.django_db
def test_profile_url_with_a_trailing_slash_redirects_to_the_canonical_form(
    client, creator_factory
):
    """The reported symptom: `/{username}/` unfurled as "not found"."""
    creator = creator_factory()

    response = _get(client, f"/{creator.username}/")

    assert response.status_code == 301, response.status_code
    assert response["Location"] == f"/{creator.username}"

    followed = _get(client, response["Location"])
    assert followed.status_code == 200
    assert creator.username in _html(followed)


@pytest.mark.django_db
def test_canonical_zpage_url_with_a_trailing_slash_redirects(
    client, creator_factory
):
    """The higher-traffic half: every URL the sitemap publishes."""
    creator = creator_factory()
    page = _page(creator, title="Slashed but shareable")

    response = _get(client, f"/{creator.username}/{page.vanity}/")

    assert response.status_code == 301, response.status_code
    assert response["Location"] == f"/{creator.username}/{page.vanity}"
    assert f"<title>{page.title}</title>" in _html(
        _get(client, response["Location"])
    )


@pytest.mark.django_db
def test_every_slashless_crawler_route_also_answers_the_slashed_shape(
    client, creator_factory
):
    """Audit the whole tier, not just the route in the issue title.

    Each of these renders a card at its slashless URL; a trailing slash must
    reach the same card in exactly one hop rather than 404.
    """
    creator = creator_factory()
    page = _page(creator, title="Audited across the tier")

    routes = [
        "/find",
        "/creators",
        "/trending",
        f"/creator/{creator.username}",
        f"/live/{creator.username}",
        f"/zpage/{page.vanity}",
        f"/article/{page.vanity}",
        f"/{creator.username}",
        f"/{creator.username}/{page.vanity}",
    ]

    for route in routes:
        assert _get(client, route).status_code == 200, route

        response = _get(client, f"{route}/")
        assert response.status_code == 301, (route, response.status_code)
        assert response["Location"] == route, route
        assert _get(client, response["Location"]).status_code == 200, route


@pytest.mark.django_db
def test_trailing_slash_redirect_preserves_the_query_string(
    client, creator_factory
):
    """`?lang=` selects the card's language; dropping it changes the card."""
    creator = creator_factory()
    page = _page(creator)

    response = _get(
        client, f"/{creator.username}/{page.vanity}/?lang=es&utm_source=x"
    )

    assert response.status_code == 301
    assert response["Location"] == (
        f"/{creator.username}/{page.vanity}?lang=es&utm_source=x"
    )


@pytest.mark.django_db
def test_trailing_slash_redirect_is_relative_never_absolute(
    client, creator_factory
):
    """Host is caller-controlled behind the GCLB (`absolute_redirect off`)."""
    creator = creator_factory()

    response = client.get(
        f"/{creator.username}/", HTTP_HOST="testserver"
    )

    assert response.status_code == 301
    assert response["Location"].startswith("/")
    assert "//" not in response["Location"]


@pytest.mark.django_db
@pytest.mark.parametrize("prefix", sorted(crawler.NON_CRAWLER_PREFIXES))
def test_non_html_prefixes_keep_their_404_on_a_trailing_slash(
    client, creator_factory, prefix
):
    """`location /api/` proxies to Django for EVERY user agent.

    So an unmatched API URL reaches the trailing-slash pattern too, and
    rewriting its 404 into a 301 would change the contract for real clients
    and monitoring -- the  family of mistake. The redirect fires only when
    the slashless target resolves to a view in the crawler module, so these
    keep exactly the status they had before.
    """
    _page(creator_factory(), vanity="unmatched", title="Should not appear")

    path = f"/{prefix}/unmatched-and-unrouted/"
    response = _get(client, path)

    # /adminzzz and /uploadz are claimed by earlier patterns (the admin
    # catch-all, the uploadz bucket redirect) and never reach the new pattern,
    # so the assertion is specific: whatever answers, it must not be the
    # trailing-slash normaliser rewriting an API 404 into a 301.
    assert response.status_code in (301, 302, 404), (
        prefix, response.status_code
    )
    if response.status_code in (301, 302):
        assert response["Location"] != path.rstrip("/"), prefix
    assert "Should not appear" not in _html(response)


@pytest.mark.django_db
def test_unresolvable_slashed_path_stays_a_404(client):
    """A 301 into a 404 is worse than a 404 for a URL that never existed."""
    for path in (
        "/api/definitely-not-a-route/",
        "/api/zpage/no-such-page/extra/",
        "/nobody/nothing/deeper/still/",
    ):
        assert _get(client, path).status_code == 404, path


@pytest.mark.django_db
def test_doubled_trailing_slash_does_not_start_a_redirect_chain(
    client, creator_factory
):
    """`.*[^/]` is what keeps `/x//` from resolving at all."""
    creator = creator_factory()

    assert _get(client, f"/{creator.username}//").status_code == 404


@pytest.mark.django_db
def test_trailing_slash_redirect_never_changes_a_write_method(
    client, creator_factory
):
    """A 301 is widely rewritten to GET; this tier must not create one."""
    creator = creator_factory()

    response = client.post(f"/{creator.username}/", HTTP_HOST=HOST)

    # status-negation-ok: the contract is "no redirect of any kind"; the exact
    # 404 is asserted on the next statement.
    assert response.status_code not in (301, 302, 307, 308), (
        response.status_code
    )
    assert response.status_code == 404, response.status_code


@pytest.mark.django_db
@pytest.mark.parametrize(
    "path",
    [
        "/api/definitely-not-a-route",
        "/api/zpage/no-such-page/extra",
        "/converse/not-a-uuid",
        "/feeds/nope",
        "/nobody/notzpage/deeper",
    ],
)
def test_a_slashless_404_never_becomes_a_redirect(client, path):
    """The regression the middleware form exists to avoid.

    The obvious fix for  is a catch-all `re_path` at the bottom of the
    URLconf. It works -- and it also makes `is_valid_path("<anything>/")`
    true, which is precisely the question
    `CommonMiddleware.should_redirect_with_slash()` asks before applying
    APPEND_SLASH. Every SLASHLESS URL that does not resolve then starts
    redirecting instead of 404ing. Measured against a real `runserver` with
    that version installed:

        /api/definitely-not-a-route -> 301 /api/definitely-not-a-route/
        /converse/not-a-uuid        -> 301 /converse/not-a-uuid/
        /feeds/nope                 -> 301 /feeds/nope/

    `location /api/` proxies to Django for EVERY user agent, so that is the
    API contract changing under real clients and monitoring, not a
    crawler-only detail. Running as a middleware over an existing 404
    registers nothing and leaves APPEND_SLASH exactly as it was.
    """
    assert _get(client, path).status_code == 404, path


@pytest.mark.django_db
def test_head_gets_the_same_redirect_as_get(client, creator_factory):
    """Several unfurlers probe with HEAD before fetching the card."""
    creator = creator_factory()

    response = client.head(f"/{creator.username}/", HTTP_HOST=HOST)

    assert response.status_code == 301, response.status_code
    assert response["Location"] == f"/{creator.username}"


@pytest.mark.django_db
def test_root_is_untouched_by_the_trailing_slash_pattern(client):
    """`/` is the site card, not a redirect to the empty string."""
    response = _get(client, "/")

    assert response.status_code == 200
    assert f"<title>{crawler.SITE_TITLE}</title>" in _html(response)


@pytest.mark.django_db
@pytest.mark.parametrize(
    "path",
    [
        "//evil.example/",
        "//evil.example/x/",
        "/\\evil.example/",
        "/\\evil.example/x/",
        "/%2f%2fevil.example/",
    ],
)
def test_trailing_slash_redirect_can_never_leave_the_origin(client, path):
    """A relative redirect must not be turnable into an off-site one.

    `//host` is protocol-relative and several browsers normalise a leading
    backslash into a slash before parsing, so both shapes are the standard way
    to turn a path redirect into an open redirect.
    """
    response = _get(client, path)

    if response.status_code in (301, 302, 307, 308):
        location = response["Location"]
        assert location.startswith("/"), location
        assert location[1:2] not in ("/", "\\"), location


@pytest.mark.django_db
@pytest.mark.parametrize(
    "prefix",
    sorted(crawler.RESERVED_FIRST_SEGMENTS - frozenset(crawler.STATIC_ROUTES)),
)
def test_a_bare_reserved_namespace_root_keeps_its_404(client, prefix):
    """`/feeds/` must not become a profile lookup (codex adversarial review).

    `path('<str:username>')` is the ONE crawler route with no negative
    lookahead -- it needs none, because nobody requests a bare `/feeds`.
    Stripping a trailing slash manufactures exactly that request, and before
    this guard existed a real server answered:

        /feeds/ /uploads/ /uploadz/ /ws/ /_app/ /static/ -> 301

    nginx proxies those namespaces to Django for EVERY user agent, so turning
    their 404 into a redirect is an API-contract change, not a crawler detail.
    """
    response = _get(client, f"/{prefix}/")

    # /api/ and /adminzzz/ are claimed by earlier patterns and never reach the
    # middleware at all; what must never happen is the slash being stripped.
    if response.status_code in (301, 302):
        assert response["Location"] != f"/{prefix}", prefix
    else:
        assert response.status_code in (200, 404), (prefix, response.status_code)


@pytest.mark.django_db
def test_a_reserved_segment_that_is_also_a_real_page_still_redirects(client):
    """`converse` is in both sets; a page beats a namespace.

    This is what keeps the guard above a statement about namespace roots
    rather than a blocklist that quietly swallows real routes.
    """
    assert "converse" in crawler.RESERVED_FIRST_SEGMENTS
    assert "converse" in crawler.STATIC_ROUTES

    response = _get(client, "/converse/")

    assert response.status_code == 301, response.status_code
    assert response["Location"] == "/converse"
    assert _get(client, "/converse").status_code == 200
