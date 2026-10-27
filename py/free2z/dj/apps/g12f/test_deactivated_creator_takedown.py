"""Deactivating a creator must take their zPages down -- on EVERY read path.

. `Creator.is_active` is the moderation lever (`ban_and_soft_delete()` is
its only writer in this codebase, and it flips exactly this flag). Deactivating
does not unpublish a single page, so every read path has to join to the creator
and check it -- and before this change, all but one of them did not:

    surface                                     before      after
    /api/zpage/{id}/              (anonymous)   200 body    404
    /api/zpage/{id}/              (subscriber)  200 body    404
    /api/zpage/{id}/variants/...                200 body    404
    /api/zpage/                 (list/feed)     listed      gone
    /api/zpage/{id}/related/                    200         404
    /api/g12f/zpage/{id}/series/  (the series)  200 strip   404
    /api/g12f/zpage/{id}/series/  (a member)    200 body    omitted
    /uploadz/public/...  (image/enclosure/HLS)  bytes       401
    /api/sitemap/zpages/{n}/{rev}/              URL listed  gone
    /feeds/zpages/recent.xml                    syndicated  gone
    /feeds/{user}/zpages/recent.xml             200         404
    /api/comments/?type=zpage                   thread      gone
    /api/tagging/autocomplete                   counted     not counted
    /api/get-type/{username}                    "creator"   404
    /api/zpage-random                           reachable   never
    g12f.publish_zpage      (scheduled publish) publishes   no-op
    g12f.notify_published_zpage  (Pub/Sub push) broadcasts  no-op
    POST /api/zpage/fund/                       funds it    400
    POST /api/zpage/{addr}/vote/                votes       404
    crawler card (fixed earlier, in )       404         404

**Status code: 404, not 410 or 403.** Reasoning, deliberately written down:

* 404 is what the two tiers that already handled deactivation return -- the
  creator profile (`CreatorView.queryset`, `_active_creator_or_404`) and the
  crawler prerender card. Introducing a second answer on the API alone
  would put the tiers back into disagreement, which is the exact failure mode
   and  were about.
* 410 asserts *permanent* removal. `is_active` does not mean that: it is
  Django's standard auth flag, it is reversible from one admin checkbox, and it
  is also what gates login. Promising crawlers "gone forever" about a state an
  operator flips back is a lie we would have to un-tell.
* 410 also has to be told apart from a *draft* by the same creator, which must
  keep 404-ing -- a distinct code there would confirm the draft exists. One
  code for both is one fewer oracle.
* 403 is strictly worse: it means "exists, but not for you", which is exactly
  the existence signal a takedown is trying to remove.

If the product later wants a fast-drop tombstone for genuine legal takedowns,
the right shape is an explicit takedown state on the model with its own 410 and
its own tombstone page -- not an overload of `is_active`. Flagged in the PR.
"""
import uuid
from decimal import Decimal
from unittest import mock

import pytest
from django.contrib.contenttypes.models import ContentType
from django.utils import timezone

from dj.apps.comments.models import Comment
from dj.apps.g12f.models import zPage
from dj.apps.g12f.models.creator import Subscription
from dj.apps.g12f.views.sitemap import (
    SITEMAP_CHUNK_SIZE,
    build_sitemap_chunk,
    make_sitemap_revision,
)


HOST = "testserver"


def _page(creator, **kwargs):
    kwargs.setdefault("vanity", f"page-{uuid.uuid4().hex[:12]}")
    kwargs.setdefault("title", "Banned headline")
    kwargs.setdefault("content", "BANNED-BODY-COPY that must stop serving.")
    kwargs.setdefault("description", "Banned description")
    kwargs.setdefault("is_published", True)
    return zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        **kwargs,
    )


def _deactivate(creator):
    """The state `ban_and_soft_delete()` leaves behind, without the ban sweep.

    Isolating the flag is the point: a moderator can also just untick
    ``is_active`` in the Django admin, and that has to be as effective as the
    scripted path.
    """
    creator.is_active = False
    creator.save(update_fields=["is_active"])


@pytest.fixture
def banned(creator_factory):
    """An active creator with a published page, and the page. Not yet banned."""
    creator = creator_factory()
    return creator, _page(creator)


# --------------------------------------------------------------------------
# The API detail route -- the headline defect
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_api_retrieve_anonymous(api_client, banned):
    creator, page = banned
    url = f"/api/zpage/{page.vanity}/"

    assert api_client.get(url).status_code == 200

    _deactivate(creator)

    response = api_client.get(url)
    assert response.status_code == 404
    assert b"BANNED-BODY-COPY" not in response.content
    #...and by the immutable address too, not just the vanity.
    assert api_client.get(f"/api/zpage/{page.free2zaddr}/").status_code == 404


@pytest.mark.django_db
def test_api_retrieve_authenticated_stranger(api_client, creator_factory, banned):
    """An ordinary logged-in reader is not a special case."""
    creator, page = banned
    reader = creator_factory()
    api_client.force_authenticate(reader)

    assert api_client.get(f"/api/zpage/{page.vanity}/").status_code == 200
    _deactivate(creator)
    assert api_client.get(f"/api/zpage/{page.vanity}/").status_code == 404


@pytest.mark.django_db
def test_api_retrieve_paying_subscriber(api_client, creator_factory, banned):
    """The subscriber carve-out does not survive the ban.

    The authenticated retrieve queryset is an OR of three arms; the creator
    gate has to be ANDed onto the two public ones, and a subscriber to the
    banned creator is exactly the reader who slips through if it is only ANDed
    onto the first.
    """
    creator, page = banned
    page.is_subscriber_only = True
    page.save(update_fields=["is_subscriber_only"])

    fan = creator_factory()
    Subscription.objects.create(
        fan=fan, star=creator,
        expires=timezone.now() + timezone.timedelta(days=30),
    )
    api_client.force_authenticate(fan)

    assert api_client.get(f"/api/zpage/{page.vanity}/").status_code == 200

    _deactivate(creator)

    response = api_client.get(f"/api/zpage/{page.vanity}/")
    assert response.status_code == 404
    assert b"BANNED-BODY-COPY" not in response.content


@pytest.mark.django_db
def test_api_retrieve_subscriber_only_does_not_raise_the_upsell(
    api_client, banned
):
    """404, not the "subscribe to read" modal.

    `MultipleFieldLookupMixin.get_object` falls back to a subscriber-only
    queryset and raises `RedirectWithModalException` instead of 404. Left
    ungated, a ban turned into an invitation to pay a banned account -- and
    confirmed the page exists.
    """
    creator, page = banned
    page.is_subscriber_only = True
    page.save(update_fields=["is_subscriber_only"])

    gated = api_client.get(f"/api/zpage/{page.vanity}/")
    assert gated.status_code == 200
    assert gated.json().get("show_modal") is True

    _deactivate(creator)

    response = api_client.get(f"/api/zpage/{page.vanity}/")
    assert response.status_code == 404
    assert b"show_modal" not in response.content


@pytest.mark.django_db
def test_api_variant_routes(api_client, banned):
    """Variant reads see exactly what retrieve sees -- including this."""
    creator, page = banned
    assert api_client.get(
        f"/api/zpage/{page.free2zaddr}/variants/").status_code == 200

    _deactivate(creator)

    assert api_client.get(
        f"/api/zpage/{page.free2zaddr}/variants/").status_code == 404
    assert api_client.get(
        f"/api/zpage/{page.free2zaddr}/variants/en/").status_code == 404


# --------------------------------------------------------------------------
# List / discovery rails
# --------------------------------------------------------------------------


def _list_vanities(response):
    return {row["vanity"] for row in response.json()["results"]}


@pytest.mark.django_db
def test_api_list_anonymous(api_client, banned):
    creator, page = banned
    assert page.vanity in _list_vanities(api_client.get("/api/zpage/"))

    _deactivate(creator)

    assert page.vanity not in _list_vanities(api_client.get("/api/zpage/"))


@pytest.mark.django_db
def test_api_list_authenticated(api_client, creator_factory, banned):
    """The authenticated homepage ORs in the reader's OWN drafts, nothing else."""
    creator, page = banned
    api_client.force_authenticate(creator_factory())
    _deactivate(creator)

    assert page.vanity not in _list_vanities(api_client.get("/api/zpage/"))


@pytest.mark.django_db
def test_api_list_by_username(api_client, banned):
    """`?username=` is how the profile tab lists a creator's work."""
    creator, page = banned
    _deactivate(creator)

    response = api_client.get(f"/api/zpage/?username={creator.username}")
    assert response.status_code == 200
    assert response.json()["results"] == []


@pytest.mark.django_db
def test_api_list_search(api_client, banned):
    """Search runs as a filter backend over the list queryset, so it inherits."""
    creator, page = banned
    _deactivate(creator)

    response = api_client.get("/api/zpage/?search=Banned")
    assert page.vanity not in _list_vanities(response)


@pytest.mark.django_db
def test_related_rail(api_client, creator_factory, banned):
    """Both directions: as the subject page, and as a candidate neighbour."""
    creator, page = banned
    neighbour_creator = creator_factory()
    neighbour = _page(neighbour_creator, title="Neighbour")

    assert api_client.get(
        f"/api/zpage/{neighbour.free2zaddr}/related/").status_code == 200

    _deactivate(creator)

    # Subject: the banned page has no related rail at all.
    assert api_client.get(
        f"/api/zpage/{page.free2zaddr}/related/").status_code == 404

    # Candidate: it must not appear under somebody else's live page either.
    related = api_client.get(f"/api/zpage/{neighbour.free2zaddr}/related/")
    assert related.status_code == 200
    assert page.vanity not in {row["vanity"] for row in related.json()}


@pytest.mark.django_db
def test_series_strip(api_client, creator_factory, banned):
    from dj.apps.g12f.models import PageOrder, Series

    creator, page = banned
    series = Series.objects.create(creator=creator, name="Banned series")
    PageOrder.objects.create(series=series, page=page, order=0)

    url = f"/api/g12f/zpage/{page.free2zaddr}/series/"
    assert api_client.get(url).status_code == 200

    _deactivate(creator)

    assert api_client.get(url).status_code == 404
    assert api_client.get(
        f"/api/g12f/zpage/{page.vanity}/series/").status_code == 404


@pytest.mark.django_db
def test_series_strip_hides_a_banned_members_page(
    api_client, creator_factory, banned
):
    """Resolving the series is one question; rendering its members is another.

    `PageOrder.page` carries no owner constraint, so a series can hold pages
    from more than one creator. Reaching such a series through a still-active
    sibling used to serve the banned member in full -- the view-level gate
    cannot see this, because the view gate never runs on the member rows.
    Found by BOTH the codex adversarial review and the read-path audit.
    """
    from dj.apps.g12f.models import PageOrder, Series

    creator, banned_page = banned
    survivor_creator = creator_factory()
    survivor = _page(survivor_creator, title="Survivor headline")

    series = Series.objects.create(creator=survivor_creator, name="Mixed")
    PageOrder.objects.create(series=series, page=survivor, order=0)
    PageOrder.objects.create(series=series, page=banned_page, order=1)

    url = f"/api/g12f/zpage/{survivor.free2zaddr}/series/"
    assert len(api_client.get(url).json()["pageorder_set"]) == 2

    _deactivate(creator)

    response = api_client.get(url)
    assert response.status_code == 200
    titles = {
        entry["page"]["title"] for entry in response.json()["pageorder_set"]
    }
    assert titles == {"Survivor headline"}
    assert b"BANNED-BODY-COPY" not in response.content


@pytest.mark.django_db
def test_series_gate_does_not_hand_the_victim_url_to_a_squatter(
    api_client, creator_factory, banned
):
    """The creator gate must run AFTER identity resolution, never inside it.

    `vanity` and `free2zaddr` are unique on their own columns but not against
    each other, so anyone can point their own page's vanity at a victim's
    immutable address. Filtering `creator__is_active` into the address lookup
    -- the obvious way to write the  fix -- makes the victim's address
    stop matching, and execution falls through to the vanity lookup where the
    squatter wins. The takedown would then serve the ATTACKER's series under
    the victim's own canonical identifier, which is strictly worse than the
    leak being fixed (codex adversarial review).
    """
    from dj.apps.g12f.models import PageOrder, Series

    victim, victim_page = banned
    squatter = creator_factory()
    # The squatter's vanity IS the victim page's address.
    squatter_page = _page(
        squatter, vanity=victim_page.free2zaddr, title="Squatter headline")
    squatter_series = Series.objects.create(
        creator=squatter, name="Squatter series")
    PageOrder.objects.create(
        series=squatter_series, page=squatter_page, order=0)

    victim_series = Series.objects.create(creator=victim, name="Victim series")
    PageOrder.objects.create(series=victim_series, page=victim_page, order=0)

    url = f"/api/g12f/zpage/{victim_page.free2zaddr}/series/"
    assert api_client.get(url).json()["name"] == "Victim series"

    _deactivate(victim)

    response = api_client.get(url)
    assert response.status_code == 404
    assert b"Squatter series" not in response.content


@pytest.mark.django_db
def test_public_uploads_stop_serving(client, banned):
    """The featured image / podcast enclosure / HLS source behind nginx.

    `/uploadz/public/...` URLs bypass every Django queryset -- nginx asks the
    auth subrequest yes/no and then serves the bytes itself -- and those URLs
    were shared and indexed long before the ban. This is the one surface where
    a 404 on the article does not take the content down.
    """
    from dj.apps.uploads.models import GenericFile

    creator, page = banned
    blob = GenericFile.objects.create(
        owner=creator,
        file=f"{creator.username}/banned-cover.png",
        mime_type="image/png",
        access="public",
    )
    headers = {"HTTP_X_ORIGINAL_URI": f"/uploadz/public/{blob.file}"}

    assert client.get("/uploads/auth-public", **headers).status_code == 200

    _deactivate(creator)

    assert client.get("/uploads/auth-public", **headers).status_code == 401
    #...and through the general gate too, which has its own public branch.
    assert client.get(
        "/uploads/auth",
        HTTP_X_ORIGINAL_URI=f"/uploadz/{blob.file}",
    ).status_code == 401


@pytest.mark.django_db
def test_banned_hls_is_not_pushed_into_the_shared_cache(client, creator_factory):
    """'s HLS gate has an owner/members/superuser fallback.

    A superuser fetching a deactivated creator's `public` HLS source is still
    authorized by that fallback -- correctly, they are staff -- but the
    response must not carry the shared-cacheable `X-HLS-Cache-Control`, or one
    admin request pushes a taken-down object into the CDN for everybody.
    """
    from dj.apps.uploads.models import GenericFile

    creator = creator_factory()
    admin = creator_factory(is_staff=True, is_superuser=True)
    blob = GenericFile.objects.create(
        owner=creator,
        file=f"{creator.username}/banned-video.mp4",
        mime_type="video/mp4",
        access="public",
    )
    url = (
        f"/uploadz/public/hls/{creator.username}"
        f"/{blob.file.name.rsplit('/', 1)[1][:-len('.mp4')]}/master.m3u8"
    )

    anon = client.get("/uploads/auth-public-hls", HTTP_X_ORIGINAL_URI=url)
    assert anon.status_code == 200
    assert anon["X-HLS-Cache-Control"].startswith("public,")

    creator.is_active = False
    creator.save(update_fields=["is_active"])

    assert client.get(
        "/uploads/auth-public-hls", HTTP_X_ORIGINAL_URI=url,
    ).status_code == 401

    client.force_login(admin)
    staff = client.get("/uploads/auth-public-hls", HTTP_X_ORIGINAL_URI=url)
    assert staff.status_code == 200
    assert staff["X-HLS-Cache-Control"] == "private, no-store"


@pytest.mark.django_db
def test_get_type_stops_naming_them(api_client, banned):
    """`/api/get-type/` is the root-URL router.

    It only leaks a route TYPE, but answering "creator" for a banned username
    sends the browser to a profile that then 404s. The resolver underneath
    stays identity-first and PUBLICATION-visibility-blind on purpose  so an owner can still preview their own draft at its root URL --
    the creator-state check is layered on after resolution, which nobody
    previewing their own page can trip.
    """
    creator, page = banned
    assert api_client.get(
        f"/api/get-type/{creator.username}").json() == "creator"
    assert api_client.get(f"/api/get-type/{page.free2zaddr}").json() == "zpage"

    _deactivate(creator)

    assert api_client.get(
        f"/api/get-type/{creator.username}").status_code == 404
    #...and the zPage half, which stays publication-visibility-blind for the
    # owner-preview case but must not keep confirming a banned creator's page
    # exists while the detail route 404s.
    assert api_client.get(
        f"/api/get-type/{page.free2zaddr}").status_code == 404
    assert api_client.get(
        f"/api/get-type/{page.vanity}").status_code == 404


@pytest.mark.django_db
def test_scheduled_publication_does_not_fire_after_a_ban(banned):
    """The queue is the read path nobody is asking for.

    A page scheduled before the ban must not publish itself afterwards, and a
    queued notification must not broadcast the body to every follower's
    notification feed and to the Pub/Sub consumers (codex adversarial review).
    """
    from dj.apps.g12f.tasks import notify_published_zpage, publish_zpage
    from dj.apps.g12f.testing import job_context

    creator, page = banned
    scheduled = _page(
        creator,
        is_published=False,
        publish_at=timezone.now() - timezone.timedelta(minutes=5),
        title="Scheduled after the ban",
    )

    _deactivate(creator)

    publish_zpage(scheduled.pk)
    scheduled.refresh_from_db()
    assert scheduled.is_published is False

    # And the already-published page's queued notification is a no-op rather
    # than a broadcast.
    emitted = []
    with mock.patch(
        "dj.apps.g12f.publication.enqueue_page_update",
        side_effect=lambda p, broadcast_id: emitted.append(p),
    ):
        notify_published_zpage(job_context(1), page.pk)
    assert emitted == []


@pytest.mark.django_db
def test_zpage_random(client, banned):
    creator, page = banned
    page.f2z_score = Decimal("10")
    page.save(update_fields=["f2z_score"])

    response = client.get("/api/zpage-random")
    assert response.status_code == 200
    assert response.content.decode() == page.get_public_url()
    assert response.content.decode() != page.get_url()

    _deactivate(creator)

    # Nothing else qualifies, so the route must 404 rather than hand out the
    # banned page's URL (or 500 on a None).
    assert client.get("/api/zpage-random").status_code == 404


@pytest.mark.django_db
def test_tag_counts(api_client, banned):
    creator, page = banned
    page.tags.add("bannedtag")

    def count_for(name):
        response = api_client.get(
            "/api/tagging/autocomplete?type=zpage&query=bannedtag")
        assert response.status_code == 200
        rows = response.json()
        rows = rows["results"] if isinstance(rows, dict) else rows
        return next(
            (row["count"] for row in rows if row["name"] == name), 0)

    assert count_for("bannedtag") == 1

    _deactivate(creator)

    assert count_for("bannedtag") == 0


# --------------------------------------------------------------------------
# Crawlable surfaces: sitemap + RSS. These invite a fetch, so leaving them
# is worse than a route that merely answers when asked.
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_sitemap_chunk_excludes_the_page(banned):
    """Both sitemaps at once: `src/lib/server/sitemap.ts` renders whatever this
    endpoint returns, so there is exactly one queryset to fix."""
    creator, page = banned
    chunk_page = (page.pk - 1) // SITEMAP_CHUNK_SIZE

    def vanities():
        chunk = build_sitemap_chunk("zpages", chunk_page)
        if chunk is None:
            return set()
        return {row["vanity"] for row in chunk["zpages"]}

    assert page.vanity in vanities()

    _deactivate(creator)

    assert page.vanity not in vanities()


def _rendered_chunk(api_client, instance):
    """The XML body of the sitemap chunk that would contain ``instance``.

    Returns ``""`` when the chunk holds no rows at all -- `build_sitemap_chunk`
    returns None and the route 404s, which is still "the URL is not
    advertised". Deriving the chunk per instance rather than assuming two
    consecutively allocated ids share one is deliberate: sequences are not
    rolled back between tests, so sooner or later a pk lands on a multiple of
    SITEMAP_CHUNK_SIZE and an adjacency assumption becomes a flaky gate (codex
    adversarial review).
    """
    page_number = (instance.pk - 1) // SITEMAP_CHUNK_SIZE
    chunk = build_sitemap_chunk("zpages", page_number)
    if chunk is None:
        assert api_client.get(
            f"/api/sitemap/zpages/{page_number}"
            f"/{make_sitemap_revision('zpages', page_number, 0)}/"
        ).status_code == 404
        return ""
    revision = make_sitemap_revision(
        "zpages", page_number, len(chunk["zpages"]))
    response = api_client.get(
        f"/api/sitemap/zpages/{page_number}/{revision}/")
    assert response.status_code == 200
    return response.content.decode()


@pytest.mark.django_db
def test_sitemap_chunk_over_http(api_client, creator_factory, banned):
    """The rendered XML, not just the queryset."""
    creator, page = banned
    survivor = _page(creator_factory(), title="Still here")

    _deactivate(creator)

    # The banned page is gone from whichever chunk would have carried it...
    assert page.vanity not in _rendered_chunk(api_client, page)
    #...and an active creator's page in (possibly) the same chunk is not
    # collateral damage.
    assert survivor.vanity in _rendered_chunk(api_client, survivor)


@pytest.mark.django_db
def test_global_zpage_feed(client, banned):
    creator, page = banned

    body = client.get("/feeds/zpages/recent.xml").content
    assert b"Banned headline" in body
    assert page.get_public_url().encode() in body
    assert page.get_url().encode() not in body

    _deactivate(creator)

    body = client.get("/feeds/zpages/recent.xml").content
    assert b"Banned headline" not in body
    assert b"Banned description" not in body


@pytest.mark.django_db
def test_per_creator_feeds_404(client, banned):
    creator, page = banned
    paths = (
        f"/feeds/{creator.username}/zpages/recent.xml",
        f"/feeds/{creator.username}/podcasts/recent.xml",
        f"/feeds/{creator.username}/converse/recent.xml",
        f"/feeds/{creator.username}/ai/recent.xml",
    )
    for path in paths:
        assert client.get(path).status_code == 200, path

    _deactivate(creator)

    for path in paths:
        assert client.get(path).status_code == 404, path


@pytest.mark.django_db
def test_crawler_card_stays_404(client, banned):
    """Regression pin for  -- the one tier that already got this right."""
    creator, page = banned
    _deactivate(creator)

    for path in (
        f"/{creator.username}/{page.vanity}",
        f"/{creator.username}/zpage/{page.vanity}",
        f"/zpage/{page.vanity}",
    ):
        response = client.get(path, HTTP_HOST=HOST)
        assert response.status_code == 404, path
        assert b"BANNED-BODY-COPY" not in response.content


# --------------------------------------------------------------------------
# Comment threads hanging off the page
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_comment_thread(api_client, creator_factory, banned):
    creator, page = banned
    commenter = creator_factory()
    Comment.objects.create(
        author=commenter,
        content="COMMENT-ON-BANNED-PAGE",
        content_type=ContentType.objects.get_for_model(zPage),
        object_id=page.pk,
    )

    def bodies():
        response = api_client.get("/api/comments/")
        assert response.status_code == 200
        return response.content

    assert b"COMMENT-ON-BANNED-PAGE" in bodies()

    _deactivate(creator)

    assert b"COMMENT-ON-BANNED-PAGE" not in bodies()
    # The public Converse RSS feed is scoped by the same predicate.
    assert b"COMMENT-ON-BANNED-PAGE" not in api_client.get(
        "/feeds/converse/recent.xml").content


# --------------------------------------------------------------------------
# Money paths -- a banned page must not be fundable or votable
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_fund_page(api_client, creator_factory, banned):
    creator, page = banned
    funder = creator_factory()
    api_client.force_authenticate(funder)
    _deactivate(creator)

    response = api_client.post(
        "/api/zpage/fund/", {"id": page.free2zaddr, "amount": 1}, format="json")
    assert response.status_code == 400
    page.refresh_from_db()
    assert page.tuzi_total == 0


@pytest.mark.django_db
def test_vote_page(api_client, creator_factory, banned):
    creator, page = banned
    voter = creator_factory()
    api_client.force_authenticate(voter)
    _deactivate(creator)

    response = api_client.post(
        f"/api/zpage/{page.free2zaddr}/vote/", {"vote": "up"}, format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
    assert response.status_code == 404
    page.refresh_from_db()
    assert page.tuzi_total == 0


# --------------------------------------------------------------------------
# Negative controls. A takedown that also takes down everyone else is not a
# fix, and these are the assertions that fail if the creator gate lands on an
# arm it does not belong on.
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_an_active_creators_page_is_untouched(api_client, creator_factory):
    creator = creator_factory()
    page = _page(creator, title="Fine headline")

    assert api_client.get(f"/api/zpage/{page.vanity}/").status_code == 200
    assert page.vanity in _list_vanities(api_client.get("/api/zpage/"))
    assert b"Fine headline" in api_client.get(
        "/feeds/zpages/recent.xml").content


@pytest.mark.django_db
def test_owner_draft_requires_explicit_private_read(api_client, creator_factory):
    """The owner may address their own draft; nobody else can.

    Draft *translations* stay behind `mine=true` (see
    test_zpage_variant_draft_reads); the page row itself is the owner's, and
    first-party embed cards  read it without `mine`.
    """
    creator = creator_factory()
    stranger = creator_factory()
    draft = _page(creator, is_published=False, title="My draft")
    api_client.force_authenticate(stranger)
    assert api_client.get(f"/api/zpage/{draft.vanity}/").status_code == 404
    api_client.force_authenticate(None)
    assert api_client.get(f"/api/zpage/{draft.vanity}/").status_code == 404
    api_client.force_authenticate(creator)

    assert api_client.get(f"/api/zpage/{draft.vanity}/").status_code == 200
    assert draft.vanity not in _list_vanities(api_client.get("/api/zpage/"))
    assert api_client.get(
        f"/api/zpage/{draft.vanity}/?mine=true"
    ).status_code == 200
    assert draft.vanity in _list_vanities(api_client.get("/api/zpage/?mine=1"))


@pytest.mark.django_db
def test_a_subscriber_still_reads_an_active_creators_paid_page(
    api_client, creator_factory
):
    creator = creator_factory()
    page = _page(creator, is_subscriber_only=True, title="Paid")
    fan = creator_factory()
    Subscription.objects.create(
        fan=fan, star=creator,
        expires=timezone.now() + timezone.timedelta(days=30),
    )
    api_client.force_authenticate(fan)

    response = api_client.get(f"/api/zpage/{page.vanity}/")
    assert response.status_code == 200
    assert response.json()["title"] == "Paid"


# --------------------------------------------------------------------------
# The helper itself. This is the part that stops the NEXT route from
# forgetting: a call site that wants "publicly visible" now has a name to ask
# for rather than two conditions to remember.
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_published_and_active_helper(creator_factory):
    active = creator_factory()
    inactive = creator_factory()
    published = _page(active)
    draft = _page(active, is_published=False)
    banned_page = _page(inactive)
    inactive.is_active = False
    inactive.save(update_fields=["is_active"])

    visible = set(zPage.objects.published_and_active().values_list(
        "pk", flat=True))
    assert visible == {published.pk}

    from_active = set(zPage.objects.from_active_creators().values_list(
        "pk", flat=True))
    assert from_active == {published.pk, draft.pk}
    assert banned_page.pk not in from_active


# --------------------------------------------------------------------------
#the surfaces the  and  enumerations both missed. Each of
# these was probed against running code before it was written -- the
# before/after status codes and bodies are in the PR.
# --------------------------------------------------------------------------


def _subscribe(fan, star):
    return Subscription.objects.create(
        fan=fan, star=star,
        expires=timezone.now() + timezone.timedelta(days=30),
        max_price=Decimal("50"),
    )


@pytest.mark.django_db
def test_my_subscriptions_redacts_a_deactivated_star(api_client, creator_factory):
    """`SimpleCreatorSerializer` publishes p2paddr, member_price, full_name.

    So this response is not merely a name: a deactivated creator kept handing
    out their Zcash address and real name through every subscriber's own
    dashboard, long after their profile and pages started 404-ing.

    The ROW stays, and that is a money contract, not a preference: this list
    carries the only ordinary unsubscribe control
    (`test_deactivated_creator_subscription_remains_cancellable`), so hiding
    it would tell a fan they have no subscription while a live recurring
    authorization sat behind it.
    """
    fan = creator_factory()
    star = creator_factory(
        p2paddr="zs1takendownaddress", full_name="Taken Down Real Name",
    )
    _subscribe(fan, star)
    api_client.force_authenticate(fan)

    before = api_client.get("/api/tuzis/my-subscriptions").json()["results"]
    assert before[0]["star"]["p2paddr"] == "zs1takendownaddress"
    assert before[0]["star"]["is_active"] is True

    _deactivate(star)

    after = api_client.get("/api/tuzis/my-subscriptions")
    assert after.status_code == 200
    assert b"zs1takendownaddress" not in after.content
    assert b"Taken Down Real Name" not in after.content
    row = after.json()["results"][0]
    # Still cancellable: the username is the path segment DELETE needs.
    assert row["star"]["username"] == star.username
    assert row["star"]["is_active"] is False
    assert row["star"]["p2paddr"] == ""
    assert row["star"]["full_name"] == ""
    assert row["star"]["member_price"] is None

    cancelled = api_client.delete(f"/api/tuzis/subscribe/{star.username}")
    assert cancelled.status_code == 200, cancelled.content


@pytest.mark.django_db
def test_my_subscribers_redacts_a_deactivated_fan(api_client, creator_factory):
    star = creator_factory()
    fan = creator_factory(
        p2paddr="zs1bannedfanaddress", full_name="Banned Fan Real Name",
    )
    _subscribe(fan, star)
    api_client.force_authenticate(star)

    before = api_client.get("/api/tuzis/my-subscribers")
    assert before.json()["results"][0]["fan"]["p2paddr"] == "zs1bannedfanaddress"

    _deactivate(fan)

    after = api_client.get("/api/tuzis/my-subscribers")
    assert after.status_code == 200
    assert b"zs1bannedfanaddress" not in after.content
    assert b"Banned Fan Real Name" not in after.content
    row = after.json()["results"][0]
    # The recipient still SEES the authorization -- hiding it would make a
    # still-live recurring charge invisible to the person being paid.
    assert row["fan"]["username"] == fan.username
    assert row["fan"]["is_active"] is False
    assert row["fan"]["p2paddr"] == ""
    assert row["fan"]["full_name"] == ""


@pytest.mark.django_db
def test_auth_user_stars_drops_a_deactivated_creator(
    api_client, creator_factory
):
    """`/api/auth/user/` is read on every session, and the UI does
    `stars.includes(username)` to decide whether to render the subscribed
    state -- so a taken-down creator kept being named, and kept rendering as
    subscribed, everywhere that gate is read.
    """
    fan = creator_factory()
    star = creator_factory()
    _subscribe(fan, star)
    api_client.force_authenticate(fan)

    assert api_client.get("/api/auth/user/").json()["stars"] == [star.username]

    _deactivate(star)

    after = api_client.get("/api/auth/user/")
    assert after.status_code == 200
    assert after.json()["stars"] == []


@pytest.mark.django_db
def test_members_tier_uploads_stop_streaming_for_a_deactivated_owner(
    client, creator_factory
):
    """The subscriber-only zPage 404s; the subscriber-only VIDEO did not.

    `has_fan()` answers "is there an unexpired Subscription row", which stays
    true after the creator is deactivated -- so both nginx auth subrequests
    kept authorizing the members blob. Measured 200/200 before this change.
    """
    from dj.apps.uploads.models import GenericFile

    creator = creator_factory()
    fan = creator_factory()
    _subscribe(fan, creator)
    blob = GenericFile.objects.create(
        owner=creator,
        file=f"{creator.username}/members-clip.mp4",
        mime_type="video/mp4",
        access="members",
    )
    hls_uri = (
        f"/uploadz/public/hls/{creator.username}/members-clip/master.m3u8"
    )
    client.force_login(fan)

    assert client.get(
        "/uploads/auth-public-hls", HTTP_X_ORIGINAL_URI=hls_uri,
    ).status_code == 200
    assert client.get(
        "/uploads/auth", HTTP_X_ORIGINAL_URI=f"/uploadz/{blob.file}",
    ).status_code == 200

    _deactivate(creator)

    assert client.get(
        "/uploads/auth-public-hls", HTTP_X_ORIGINAL_URI=hls_uri,
    ).status_code == 401
    assert client.get(
        "/uploads/auth", HTTP_X_ORIGINAL_URI=f"/uploadz/{blob.file}",
    ).status_code == 401


@pytest.mark.django_db
def test_a_subscriber_still_streams_an_active_creators_members_upload(
    client, creator_factory
):
    """Positive control: the paid tier must keep working for live creators."""
    from dj.apps.uploads.models import GenericFile

    creator = creator_factory()
    fan = creator_factory()
    _subscribe(fan, creator)
    blob = GenericFile.objects.create(
        owner=creator,
        file=f"{creator.username}/paid-clip.mp4",
        mime_type="video/mp4",
        access="members",
    )
    client.force_login(fan)

    assert client.get(
        "/uploads/auth", HTTP_X_ORIGINAL_URI=f"/uploadz/{blob.file}",
    ).status_code == 200
    #...and a non-subscriber still cannot.
    stranger = creator_factory()
    client.force_login(stranger)
    assert client.get(
        "/uploads/auth", HTTP_X_ORIGINAL_URI=f"/uploadz/{blob.file}",
    ).status_code == 401
