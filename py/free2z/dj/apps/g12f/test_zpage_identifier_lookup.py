"""Which zPage does a URL segment name?

The precedence is **exact ``free2zaddr`` -> exact ``vanity`` -> canonical
``slugify(vanity)`` -> ``vanity__iexact``** and it lives in one place,
``dj.apps.g12f.identifiers.resolve_zpage_pk``. Getting the order wrong
serves one account's content under another account's URL, so each tier gets a
test, including the case where two tiers both have a candidate.
"""
import uuid

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework import serializers
from rest_framework.test import APIClient

from dj.apps.g12f.models import zPage
from dj.apps.g12f.serializers.zpage import zPageUpdateSerializer


def _page(creator, *, vanity, free2zaddr=None, title=None):
    return zPage.objects.create(
        creator=creator,
        free2zaddr=free2zaddr or str(uuid.uuid4()),
        vanity=vanity,
        title=title or vanity,
        content=f"Content for {title or vanity}",
        is_published=True,
    )


def _owner_client(creator):
    client = APIClient()
    client.force_authenticate(creator)
    return client


@pytest.mark.django_db
def test_create_vanity_is_slugified_and_runs_all_validation(creator_factory):
    serializer = zPageUpdateSerializer(data={
        "title": "A page",
        "content": "Page content",
        "tags": [],
        "vanity": "CoolStuff",
    })

    assert serializer.is_valid(), serializer.errors
    assert serializer.validated_data["vanity"] == "coolstuff"

    _page(creator_factory(), vanity="coolstuff")
    duplicate = zPageUpdateSerializer(data={
        "title": "Another page",
        "content": "More content",
        "tags": [],
        "vanity": "COOLSTUFF",
    })
    assert not duplicate.is_valid()
    assert "not unique" in str(duplicate.errors["vanity"])


@pytest.mark.django_db
def test_create_vanity_cannot_shadow_reserved_name_or_page_address(
    creator_factory,
):
    serializer = zPageUpdateSerializer()

    with pytest.raises(serializers.ValidationError, match="reserved"):
        serializer.validate_vanity("dashboard")

    address = "victim-address"
    _page(creator_factory(), vanity="victim-page", free2zaddr=address)
    with pytest.raises(serializers.ValidationError, match="free2zaddr"):
        serializer.validate_vanity(address)


@pytest.mark.django_db
def test_free2zaddr_wins_over_a_squatted_vanity(api_client, creator_factory):
    attacker = creator_factory(username="identifier-attacker")
    victim = creator_factory(username="identifier-victim")
    address = f"victim-{uuid.uuid4().hex}"

    _page(
        attacker,
        vanity=address,
        title="Attacker page",
    )
    victim_page = _page(
        victim,
        vanity="victim-page",
        free2zaddr=address,
        title="Victim page",
    )

    response = api_client.get(f"/api/zpage/{address}/")

    assert response.status_code == 200, response.content
    assert response.json()["free2zaddr"] == victim_page.free2zaddr
    assert response.json()["title"] == "Victim page"


@pytest.mark.django_db
def test_canonical_vanity_wins_over_legacy_mixed_case_squatter(
    api_client, creator_factory,
):
    _page(
        creator_factory(username="case-attacker"),
        vanity="CoolStuff",
        title="Attacker page",
    )
    victim_page = _page(
        creator_factory(username="case-victim"),
        vanity="coolstuff",
        title="Victim page",
    )

    response = api_client.get("/api/zpage/coolstuff/")

    assert response.status_code == 200, response.content
    assert response.json()["free2zaddr"] == victim_page.free2zaddr
    assert response.json()["title"] == "Victim page"


@pytest.mark.django_db
def test_hidden_canonical_vanity_does_not_fall_through_to_legacy_squatter(
    api_client, creator_factory,
):
    _page(
        creator_factory(username="hidden-case-attacker"),
        vanity="CoolStuff",
        title="Attacker page",
    )
    victim_page = _page(
        creator_factory(username="hidden-case-victim"),
        vanity="coolstuff",
        title="Hidden victim page",
    )
    victim_page.is_published = False
    victim_page.save(update_fields=["is_published"])

    response = api_client.get("/api/zpage/coolstuff/")

    assert response.status_code == 404


@pytest.mark.django_db
def test_hidden_exact_address_never_falls_through_to_public_squatter(
    api_client, creator_factory,
):
    address = f"hidden-{uuid.uuid4().hex}"
    _page(
        creator_factory(username="hidden-attacker"),
        vanity=address,
        title="Attacker page",
    )
    victim_page = _page(
        creator_factory(username="hidden-victim"),
        vanity="hidden-victim-page",
        free2zaddr=address,
        title="Hidden victim page",
    )
    victim_page.is_published = False
    victim_page.save(update_fields=["is_published"])

    response = api_client.get(f"/api/zpage/{address}/")

    assert response.status_code == 404


@pytest.mark.django_db
def test_subscriber_exact_address_shows_victim_modal_not_public_squatter(
    api_client, creator_factory,
):
    address = f"premium-{uuid.uuid4().hex}"
    _page(
        creator_factory(username="premium-attacker"),
        vanity=address,
        title="Attacker page",
    )
    victim_page = _page(
        creator_factory(username="premium-victim"),
        vanity="premium-victim-page",
        free2zaddr=address,
        title="Premium victim page",
    )
    victim_page.is_subscriber_only = True
    victim_page.save(update_fields=["is_subscriber_only"])

    response = api_client.get(f"/api/zpage/{address}/")

    assert response.status_code == 200, response.content
    assert response.json()["show_modal"] is True
    assert response.json()["page"]["free2zaddr"] == victim_page.free2zaddr
    assert response.json()["page"]["title"] == "Premium victim page"


@pytest.mark.django_db
def test_related_hidden_exact_address_does_not_use_public_squatter(
    api_client, creator_factory,
):
    address = f"related-hidden-{uuid.uuid4().hex}"
    _page(
        creator_factory(username="related-attacker"),
        vanity=address,
        title="Attacker page",
    )
    victim_page = _page(
        creator_factory(username="related-victim"),
        vanity="related-hidden-victim",
        free2zaddr=address,
        title="Hidden victim page",
    )
    victim_page.is_published = False
    victim_page.save(update_fields=["is_published"])

    response = api_client.get(f"/api/zpage/{address}/related/")

    assert response.status_code == 404


@pytest.mark.django_db
def test_get_type_handles_a_cross_column_identifier_collision(
    api_client, creator_factory,
):
    address = f"type-{uuid.uuid4().hex}"
    _page(creator_factory(), vanity=address, title="Squatter")
    _page(
        creator_factory(),
        vanity="identity-page",
        free2zaddr=address,
        title="Identity",
    )

    response = api_client.get(f"/api/get-type/{address}")

    assert response.status_code == 200, response.content
    assert response.json() == "zpage"


# ---------------------------------------------------------------------------
#  §1 — exact before canonical before iexact
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_exact_vanity_beats_the_canonical_slug_of_the_same_segment(
    api_client, creator_factory,
):
    """`vanity` is a SlugField: `-foo` is a legal legacy value.

    ``slugify("-foo") == "foo"``, so a canonical-first lookup answered
    ``/-foo/`` with the unrelated ``foo`` page. What the row literally stores
    is its own URL and must win.
    """
    legacy_page = _page(
        creator_factory(username="dash-legacy"),
        vanity="-dashed-slug",
        title="Legacy dashed page",
    )
    _page(
        creator_factory(username="dash-canonical"),
        vanity="dashed-slug",
        title="Canonical page",
    )

    response = api_client.get("/api/zpage/-dashed-slug/")

    assert response.status_code == 200, response.content
    assert response.json()["free2zaddr"] == legacy_page.free2zaddr
    assert response.json()["title"] == "Legacy dashed page"


@pytest.mark.django_db
def test_exact_vanity_resolves_even_when_the_canonical_page_is_hidden(
    api_client, creator_factory,
):
    """The exact match must not be 404'd by an unrelated hidden neighbour.

    Resolution fails closed once a tier matches, so a canonical-first order
    turned ``/-foo/`` into a 404 whenever the ``foo`` page happened to be
    unpublished -- for a page that matches the segment exactly and is public.
    """
    legacy_page = _page(
        creator_factory(username="hidden-neighbour-legacy"),
        vanity="-hidden-neighbour",
        title="Legacy dashed page",
    )
    canonical = _page(
        creator_factory(username="hidden-neighbour-canonical"),
        vanity="hidden-neighbour",
        title="Hidden canonical page",
    )
    canonical.is_published = False
    canonical.save(update_fields=["is_published"])

    response = api_client.get("/api/zpage/-hidden-neighbour/")

    assert response.status_code == 200, response.content
    assert response.json()["free2zaddr"] == legacy_page.free2zaddr


@pytest.mark.django_db
def test_each_legacy_case_variant_keeps_its_own_exact_url(
    api_client, creator_factory,
):
    """The collision case: an exact match AND a case-variant both exist.

    Only legacy data can be in this state (the serializer rejects a new
    ``iexact`` duplicate), and each row's own literal vanity is its own
    canonical URL. Neither may shadow the other.
    """
    legacy_page = _page(
        creator_factory(username="variant-legacy"),
        vanity="CoolStuff",
        title="Legacy page",
    )
    canonical_page = _page(
        creator_factory(username="variant-canonical"),
        vanity="coolstuff",
        title="Canonical page",
    )

    legacy = api_client.get("/api/zpage/CoolStuff/")
    canonical = api_client.get("/api/zpage/coolstuff/")

    assert legacy.status_code == 200, legacy.content
    assert legacy.json()["free2zaddr"] == legacy_page.free2zaddr
    assert canonical.status_code == 200, canonical.content
    assert canonical.json()["free2zaddr"] == canonical_page.free2zaddr


@pytest.mark.django_db
def test_a_link_matching_neither_exactly_prefers_the_canonical_row(
    api_client, creator_factory,
):
    """'s rule, retained: canonical beats the lowest-pk legacy row.

    ``/COOLSTUFF/`` matches no row exactly. The older ``CoolStuff`` row is
    created first so it would win a plain ``iexact`` + ``order_by("pk")``;
    the canonical tier must still pick ``coolstuff``.
    """
    _page(
        creator_factory(username="fallback-legacy"),
        vanity="CoolStuff",
        title="Legacy page",
    )
    canonical_page = _page(
        creator_factory(username="fallback-canonical"),
        vanity="coolstuff",
        title="Canonical page",
    )

    response = api_client.get("/api/zpage/COOLSTUFF/")

    assert response.status_code == 200, response.content
    assert response.json()["free2zaddr"] == canonical_page.free2zaddr


@pytest.mark.django_db
def test_a_mixed_case_only_vanity_is_still_reachable_lowercased(
    api_client, creator_factory,
):
    """The legacy ``iexact`` tier still exists for links to old URLs."""
    legacy_page = _page(
        creator_factory(username="lonely-legacy"),
        vanity="LonelyLegacy",
        title="Legacy page",
    )

    response = api_client.get("/api/zpage/lonelylegacy/")

    assert response.status_code == 200, response.content
    assert response.json()["free2zaddr"] == legacy_page.free2zaddr


# ---------------------------------------------------------------------------
#  §2 — /api/get-type/ answers with the detail route's precedence
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_unknown_get_type_ssr_lookup_has_a_bounded_query_cost(api_client):
    """A scanner miss cannot grow past the resolver's documented tiers."""
    with CaptureQueriesContext(connection) as queries:
        response = api_client.get("/api/get-type/SSR-Unknown-Root-Fixture")

    assert response.status_code == 404
    assert len(queries) <= 4, queries.captured_queries


@pytest.mark.django_db
def test_get_type_and_the_detail_route_agree_on_a_mixed_case_address(
    api_client, creator_factory,
):
    """A "zpage" answer the detail route then 404s on is a broken page.

    ``get-type`` used to match ``free2zaddr__iexact`` while the detail route
    matches exactly, so a differently-cased address opened the zPage view and
    the view's own fetch came back empty.
    """
    address = f"MixedAddr-{uuid.uuid4().hex}"
    _page(creator_factory(), vanity="mixed-addr-page", free2zaddr=address)

    variant = address.lower()
    assert variant != address

    get_type = api_client.get(f"/api/get-type/{variant}")
    detail = api_client.get(f"/api/zpage/{variant}/")

    assert detail.status_code == 404
    assert get_type.status_code == 404

    assert api_client.get(f"/api/get-type/{address}").json() == "zpage"
    assert api_client.get(f"/api/zpage/{address}/").status_code == 200


@pytest.mark.django_db
def test_get_type_still_resolves_a_legacy_mixed_case_vanity(
    api_client, creator_factory,
):
    _page(creator_factory(), vanity="LegacyTypeVanity", title="Legacy")

    response = api_client.get("/api/get-type/legacytypevanity")

    assert response.status_code == 200, response.content
    assert response.json() == "zpage"


@pytest.mark.django_db
def test_get_type_routes_an_unpublished_page_to_the_zpage_view(
    api_client, creator_factory,
):
    """Type routing is visibility-blind on purpose: the owner previews drafts
    at the page's root URL, and the zPage view does the authorization."""
    page = _page(creator_factory(), vanity="draft-type-page", title="Draft")
    page.is_published = False
    page.save(update_fields=["is_published"])

    response = api_client.get("/api/get-type/draft-type-page")

    assert response.status_code == 200, response.content
    assert response.json() == "zpage"


# ---------------------------------------------------------------------------
#  §3 — a save that does not change the vanity does not rewrite it
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_editing_a_title_never_normalizes_an_untouched_legacy_vanity(
    creator_factory,
):
    """Clients PUT the whole object back, so an echoed vanity is "unchanged".

    Normalizing it would move a legacy page's canonical URL as a side effect
    of an unrelated edit -- a persisted change the user never asked for.
    """
    creator = creator_factory(username="untouched-vanity-owner")
    page = _page(creator, vanity="CoolStuff", title="Before")

    response = _owner_client(creator).patch(
        f"/api/zpage/{page.free2zaddr}/",
        {"title": "After", "vanity": "CoolStuff"},
        format="json",
    )

    assert response.status_code == 200, response.content
    page.refresh_from_db()
    assert page.title == "After"
    assert page.vanity == "CoolStuff"


@pytest.mark.django_db
def test_omitting_the_vanity_entirely_leaves_it_untouched(creator_factory):
    creator = creator_factory(username="omitted-vanity-owner")
    page = _page(creator, vanity="CoolStuff", title="Before")

    response = _owner_client(creator).patch(
        f"/api/zpage/{page.free2zaddr}/", {"title": "After"}, format="json",
    )

    assert response.status_code == 200, response.content
    page.refresh_from_db()
    assert page.vanity == "CoolStuff"


@pytest.mark.django_db
def test_actually_changing_the_vanity_still_normalizes_it(creator_factory):
    """The fix is scoped to *untouched* values; a real edit is still slugified
    and still runs every uniqueness and reserved-name check.

    Note the value is already a legal slug: ``SlugField``'s own validator runs
    before ``validate_vanity``, so anything with a space is a 400 and never
    reaches normalization. In practice slugify here only folds case and trims
    edge characters -- which is exactly why an echoed legacy value looked like
    a no-op change and got rewritten anyway.
    """
    creator = creator_factory(username="changed-vanity-owner")
    page = _page(creator, vanity="CoolStuff", title="Before")

    response = _owner_client(creator).patch(
        f"/api/zpage/{page.free2zaddr}/",
        {"vanity": "Brand-New-Name"},
        format="json",
    )

    assert response.status_code == 200, response.content
    page.refresh_from_db()
    assert page.vanity == "brand-new-name"


@pytest.mark.django_db
def test_an_untouched_reserved_legacy_vanity_does_not_block_an_edit(
    creator_factory,
):
    """A legacy row whose vanity is now reserved must stay editable.

    It could not be created today, but refusing every future save of the page
    would be a worse outcome than leaving the grandfathered URL in place.
    """
    creator = creator_factory(username="reserved-legacy-owner")
    page = _page(creator, vanity="dashboard", title="Before")

    response = _owner_client(creator).patch(
        f"/api/zpage/{page.free2zaddr}/",
        {"title": "After", "vanity": "dashboard"},
        format="json",
    )

    assert response.status_code == 200, response.content
    page.refresh_from_db()
    assert page.vanity == "dashboard"
