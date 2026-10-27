"""The Converse stream's filters may only ever NARROW the visible queryset.

`/converse` now drives `GET /api/comments/` through the generated client and
exposes the `tags`, `subscribed_to`, `ordering` and `search` parameters that
`CommentFilter` has always declared but that nothing in the new UI reached.
Exposing a filter is exposing a new way to ask the question, and the answer has
to keep obeying `scope_comments_to_visible_parents`.

That matters because of: a standalone converse post (``content_type IS
NULL``) is public only while its **author's account is active**. Deactivating
an author must take their microblog corpus off `/api/comments/`, the RSS feed
and the OG card. `test_deactivated_author_standalone.py` pins the unfiltered
list; this file pins the filtered ones, because a filter applied to the wrong
queryset is exactly how that kind of scoping regresses -- the endpoint keeps
200ing and only a query nobody ran before leaks.

Every test here is a pair: the control proves the fixture really does produce
the post through that parameter while the author is active, so a pass cannot be
"the filter matched nothing anyway".

Run with your own Postgres:

    DBHOST=127.0.0.1 DBPORT=<yours> DBNAME=free2z DBUSER=free2z DBPASS=free2z \\
      python -m pytest dj/apps/comments/test_converse_stream_filters.py
"""
import uuid as uuid_module
from datetime import timedelta
from urllib.parse import parse_qsl, urlparse

import pytest

from django.contrib.contenttypes.models import ContentType
from django.utils import timezone

from dj.apps.comments.models import Comment
from dj.apps.g12f.models import zPage
from dj.apps.g12f.models.creator import Subscription

pytestmark = pytest.mark.django_db


def _deactivate(creator):
    creator.is_active = False
    creator.save(update_fields=['is_active'])


def _standalone(author, content, tags=(), tuzis=1):
    comment = Comment.objects.create(
        author=author, content=content, tuzis=tuzis)
    if tags:
        comment.tags.add(*tags)
    return comment


def _uuids(response):
    return {c["uuid"] for c in response.data["results"]}


def _zpage_root_comment(author, page_owner, content):
    """A FIRST-LEVEL comment on a published zPage.

    The shape the microblog filter has to exclude: no ``parent`` -- so
    ``parent__isnull=true`` matches it -- but a ``content_type``, which is what
    ``visibility.py`` uses to tell an article's comment thread apart from
    standalone converse content.
    """
    page = zPage.objects.create(
        creator=page_owner,
        title="public page",
        content="body",
        free2zaddr=str(uuid_module.uuid4()),
        vanity=f"pub-{page_owner.username}-{uuid_module.uuid4().hex[:8]}",
        is_published=True,
    )
    return Comment.objects.create(
        author=author,
        content=content,
        tuzis=1,
        content_type=ContentType.objects.get_for_model(zPage),
        object_id=str(page.id),
    )


@pytest.fixture
def poster(creator_factory):
    """The author who gets deactivated mid-test."""
    return creator_factory(username="streamposter")


@pytest.fixture
def keeper(creator_factory):
    """An author who stays active throughout -- the positive control."""
    return creator_factory(username="streamkeeper")


@pytest.fixture
def fan(creator_factory):
    return creator_factory(username="streamfan")


def _subscribe(fan, star, days=30):
    return Subscription.objects.create(
        fan=fan, star=star, expires=timezone.now() + timedelta(days=days))


# --------------------------------------------------------------------------
# ?tags= -- the new tag filter
# --------------------------------------------------------------------------


def test_tag_filter_cannot_resurface_a_deactivated_authors_post(
    api_client, poster, keeper,
):
    hidden = _standalone(poster, "TAGGED-GONE-BODY", tags=["zcash"])
    shown = _standalone(keeper, "TAGGED-STAYS-BODY", tags=["zcash"])

    # Control: the tag filter really does return both while both are active.
    resp = api_client.get("/api/comments/?tags=zcash")
    assert resp.status_code == 200, resp.content
    assert _uuids(resp) == {str(hidden.uuid), str(shown.uuid)}

    _deactivate(poster)

    resp = api_client.get("/api/comments/?tags=zcash")
    assert resp.status_code == 200, resp.content
    assert str(hidden.uuid) not in _uuids(resp)
    assert str(shown.uuid) in _uuids(resp)
    assert b"TAGGED-GONE-BODY" not in resp.content
    assert b"streamposter" not in resp.content


def test_tag_filter_is_case_insensitive_on_both_sides_of_the_gate(
    api_client, poster,
):
    """`CommaSeparatedCharFilter` matches `iexact`, so a differently-cased tag
    is a second way to ask the same question. It must not be a way around."""
    _standalone(poster, "CASED-TAG-BODY", tags=["Zcash"])

    control = api_client.get("/api/comments/?tags=zcash")
    assert control.status_code == 200, control.content
    assert b"CASED-TAG-BODY" in control.content

    _deactivate(poster)

    for query in ("?tags=zcash", "?tags=Zcash", "?tags=ZCASH"):
        resp = api_client.get(f"/api/comments/{query}")
        assert resp.status_code == 200, resp.content
        assert b"CASED-TAG-BODY" not in resp.content
        assert resp.data["results"] == []


# --------------------------------------------------------------------------
# ?subscribed_to= -- the new All/Following toggle
# --------------------------------------------------------------------------


def test_subscribed_filter_cannot_resurface_a_deactivated_authors_post(
    api_client, poster, keeper, fan,
):
    hidden = _standalone(poster, "SUBSCRIBED-GONE-BODY")
    shown = _standalone(keeper, "SUBSCRIBED-STAYS-BODY")
    _subscribe(fan, poster)
    _subscribe(fan, keeper)
    api_client.force_authenticate(user=fan)

    # Control: a subscriber genuinely sees both through this filter.
    resp = api_client.get("/api/comments/?subscribed_to=1")
    assert resp.status_code == 200, resp.content
    assert _uuids(resp) == {str(hidden.uuid), str(shown.uuid)}

    _deactivate(poster)

    resp = api_client.get("/api/comments/?subscribed_to=1")
    assert resp.status_code == 200, resp.content
    assert str(hidden.uuid) not in _uuids(resp)
    assert str(shown.uuid) in _uuids(resp)
    assert b"SUBSCRIBED-GONE-BODY" not in resp.content


def test_anonymous_subscribed_filter_degrades_to_the_full_stream(
    api_client, keeper,
):
    """`filter_subscribed_to` returns the queryset UNCHANGED for an anonymous
    caller rather than erroring. That is the documented degradation the UI
    relies on when a `?subscribed=1` link is opened signed-out -- pin it, so a
    later change to the filter cannot turn a shared link into a 4xx."""
    post = _standalone(keeper, "ANON-SUBSCRIBED-BODY")

    resp = api_client.get("/api/comments/?subscribed_to=1")
    assert resp.status_code == 200, resp.content
    assert str(post.uuid) in _uuids(resp)


def test_anonymous_subscribed_filter_still_hides_deactivated_authors(
    api_client, poster,
):
    """...and degrading to the full stream must mean the full VISIBLE stream."""
    _standalone(poster, "ANON-SUBSCRIBED-GONE-BODY")
    control = api_client.get("/api/comments/?subscribed_to=1")
    assert control.status_code == 200, control.content
    assert b"ANON-SUBSCRIBED-GONE-BODY" in control.content

    _deactivate(poster)

    resp = api_client.get("/api/comments/?subscribed_to=1")
    assert resp.status_code == 200, resp.content
    assert b"ANON-SUBSCRIBED-GONE-BODY" not in resp.content


# --------------------------------------------------------------------------
# ?ordering= and ?search= -- reachable before, but now reachable together
# with the above, so pin them on the same fixture
# --------------------------------------------------------------------------


def test_hot_ordering_cannot_resurface_a_deactivated_authors_post(
    api_client, poster, keeper,
):
    """The Hot sort is `-tuzis`. A well-backed post from a deactivated author
    would sort to the very top of the feed -- the most visible possible place
    for a leak."""
    hidden = _standalone(poster, "HOT-GONE-BODY", tuzis=9999)
    _standalone(keeper, "HOT-STAYS-BODY", tuzis=1)

    control = api_client.get("/api/comments/?ordering=-tuzis")
    assert control.status_code == 200, control.content
    assert control.data["results"][0]["uuid"] == str(hidden.uuid)

    _deactivate(poster)

    resp = api_client.get("/api/comments/?ordering=-tuzis")
    assert resp.status_code == 200, resp.content
    assert str(hidden.uuid) not in _uuids(resp)
    assert b"HOT-GONE-BODY" not in resp.content


def test_search_is_not_an_existence_oracle_for_a_hidden_post(
    api_client, poster,
):
    _standalone(poster, "SEARCHABLE-GONE-BODY")

    control = api_client.get("/api/comments/?search=SEARCHABLE-GONE-BODY")
    assert control.status_code == 200, control.content
    assert control.data["count"] == 1

    _deactivate(poster)

    for query in ("?search=SEARCHABLE-GONE-BODY", "?search=streamposter"):
        resp = api_client.get(f"/api/comments/{query}")
        assert resp.status_code == 200, resp.content
        assert resp.data["count"] == 0
        assert resp.data["results"] == []


def test_filters_compose_without_widening_the_scope(
    api_client, poster, keeper, fan,
):
    """The UI can send tags + subscribed_to + ordering + search at once.
    Django-filter ANDs them onto `get_queryset()`, but 'obviously' is not
    evidence -- the combination is what the feed actually sends."""
    hidden = _standalone(
        poster, "COMBINED-GONE-BODY zebra", tags=["zcash"], tuzis=500)
    _subscribe(fan, poster)
    _subscribe(fan, keeper)
    api_client.force_authenticate(user=fan)

    combined = "?tags=zcash&subscribed_to=1&ordering=-tuzis&search=zebra"

    control = api_client.get(f"/api/comments/{combined}")
    assert control.status_code == 200, control.content
    assert _uuids(control) == {str(hidden.uuid)}

    _deactivate(poster)

    resp = api_client.get(f"/api/comments/{combined}")
    assert resp.status_code == 200, resp.content
    assert resp.data["results"] == []
    assert b"COMBINED-GONE-BODY" not in resp.content


# --------------------------------------------------------------------------
# ?pagination=cursor -- stable keyset pagination for the live stream
# --------------------------------------------------------------------------


def _cursor_from_next(next_url):
    """The opaque `cursor` query parameter out of the envelope's next link."""
    return dict(parse_qsl(urlparse(next_url).query))["cursor"]


def _walk(api_client, url):
    """Follow `next` to the end of the stream, exactly as load-more would."""
    seen = []
    while url:
        resp = api_client.get(url)
        assert resp.status_code == 200, resp.content
        seen.extend(c["uuid"] for c in resp.data["results"])
        url = resp.data["next"]
    return seen


def test_cursor_stream_drops_no_post_when_one_arrives_mid_scroll(
    api_client, keeper,
):
    """THE property: a post arriving between two fetches must not shift rows
    across the page boundary. Under offset pagination the insert pushes a row
    from page two onto page one's slot, so scrolling serves it TWICE and
    silently drops another. This test fails under offset pagination."""
    original = [_standalone(keeper, f"CURSOR-STABLE-{i}") for i in range(5)]

    first = api_client.get("/api/comments/?pagination=cursor&page_size=2")
    assert first.status_code == 200, first.content
    page_one = [c["uuid"] for c in first.data["results"]]
    assert len(page_one) == 2
    assert first.data["next"], "five posts at page_size=2 must have a next"
    assert first.data["previous"] is None
    assert first.data["count"] == 5

    # The common case on a live microblog, not an edge case: new mail arrives
    # while the reader is still reading.
    _standalone(keeper, "CURSOR-ARRIVES-LATE")

    seen = page_one + _walk(api_client, first.data["next"])

    # No duplicates, no omissions among what existed when the scroll began.
    # (The late arrival is newer than the boundary and correctly belongs to
    # no fetched page; a refresh picks it up.)
    assert len(seen) == len(set(seen)), "a post was served twice"
    assert set(seen) == {str(post.uuid) for post in original}


def test_cursor_stream_is_newest_first(api_client, keeper):
    posts = [_standalone(keeper, f"CURSOR-ORDER-{i}") for i in range(4)]
    seen = _walk(api_client, "/api/comments/?pagination=cursor&page_size=3")
    assert seen == [str(post.uuid) for post in reversed(posts)]


def test_equal_timestamps_straddle_a_page_boundary_without_loss(
    api_client, keeper,
):
    """The UUID tiebreak is the whole reason the tiebreak column exists.

    Five posts share ONE created_at (auto_now_add at bulk-import speed);
    page_size=2 puts a boundary INSIDE that tie group. A keyset boundary
    anchored to (created_at, uuid) must still partition them exactly:
    scrolling to the end yields every post once.
    """
    shared = timezone.now().replace(microsecond=0)
    posts = [_standalone(keeper, f"TIE-BREAK-{i}") for i in range(5)]
    Comment.objects.filter(pk__in=[p.pk for p in posts]).update(
        created_at=shared)

    seen = _walk(api_client, "/api/comments/?pagination=cursor&page_size=2")

    assert len(seen) == len(set(seen)), "a tied post was served twice"
    assert set(seen) == {str(post.uuid) for post in posts}


def test_page_number_mode_stays_the_default(api_client, keeper):
    """Compatibility: nothing changes for a client that did not opt in."""
    for i in range(3):
        _standalone(keeper, f"NUMBERED-{i}")

    resp = api_client.get("/api/comments/?page_size=2")
    assert resp.status_code == 200, resp.content
    assert "page=2" in resp.data["next"]
    assert "cursor=" not in resp.data["next"]

    page_two = api_client.get(resp.data["next"])
    assert page_two.status_code == 200, page_two.content
    assert page_two.data["previous"] is not None


def test_cursor_mode_keeps_the_page_number_response_contract(
    api_client, keeper,
):
    """Both modes hand clients the SAME envelope, so a mode switch is
    invisible to consumers."""
    _standalone(keeper, "CURSOR-SHAPE-BODY")

    numbered = api_client.get("/api/comments/")
    cursored = api_client.get("/api/comments/?pagination=cursor")
    assert numbered.status_code == 200 and cursored.status_code == 200
    assert set(numbered.data.keys()) == set(cursored.data.keys())
    assert numbered.data["results"] == cursored.data["results"]


def test_hot_ordering_is_refused_in_cursor_mode(api_client, keeper):
    """`-tuzis` is mutable -- every vote reshuffles the feed, so a cursor
    anchored to it would skip or repeat posts. Hot stays on page numbers,
    and asking to combine them is a loud client error, never a silent
    fallback to creation order under a UI that says Hot."""
    _standalone(keeper, "CURSOR-HOT-BODY")

    resp = api_client.get("/api/comments/?pagination=cursor&ordering=-tuzis")
    assert resp.status_code == 400, resp.content
    assert "ordering" in resp.data

    # Control: the same request WITHOUT cursor mode keeps working.
    ok = api_client.get("/api/comments/?ordering=-tuzis")
    assert ok.status_code == 200, ok.content


def test_ascending_created_at_is_refused_in_cursor_mode(api_client):
    """The paginator force-applies -created_at,-uuid whatever the URL says;
    accepting `ordering=created_at` would serve newest-first under a URL that
    claims oldest-first. An allowlist, not just a tuzis blocklist."""
    resp = api_client.get("/api/comments/?pagination=cursor&ordering=created_at")
    assert resp.status_code == 400, resp.content


@pytest.mark.parametrize("ordering", ["-created_at", "-created_at,-uuid"])
def test_explicit_newest_first_ordering_is_accepted_in_cursor_mode(
    api_client, keeper, ordering,
):
    _standalone(keeper, "CURSOR-EXPLICIT-ORDERING")
    resp = api_client.get(
        f"/api/comments/?pagination=cursor&ordering={ordering}")
    assert resp.status_code == 200, resp.content
    assert resp.data["count"] == 1


def test_page_number_is_refused_in_cursor_mode(api_client, keeper):
    _standalone(keeper, "CURSOR-PAGE-BODY")
    resp = api_client.get("/api/comments/?pagination=cursor&page=2")
    assert resp.status_code == 400, resp.content
    assert "page" in resp.data


def test_garbage_cursor_is_a_404_in_cursor_mode(api_client, keeper):
    """A forged/truncated token must fall off the end as `Invalid cursor.`
    (404), not leak an ORM error as a 500 or silently serve page one."""
    _standalone(keeper, "CURSOR-JUNK-BODY")
    for junk in (
        "not-a-cursor",
        "eyJ2IjoxfQ",  # {"v":1}
        # {"v":1,"ordering":"-created_at","position":[1,2]} -- ints
        "eyJ2IjoxLCJvcmRlcmluZyI6Ii1jcmVhdGVkX2F0IiwicG9zaXRpb24iOlsxLDJdfQ",
    ):
        resp = api_client.get(
            f"/api/comments/?pagination=cursor&cursor={junk}")
        assert resp.status_code == 404, (junk, resp.content)


def test_bare_cursor_without_the_mode_parameter_is_a_400(api_client, keeper):
    """An ignored cursor would serve page one under a UI that believes it is
    showing page five. Mirrors zPageView: supplying `cursor=` without
    `pagination=cursor` is a client error."""
    for i in range(3):
        _standalone(keeper, f"CURSOR-BARE-BODY-{i}")

    first = api_client.get("/api/comments/?pagination=cursor&page_size=2")
    assert first.status_code == 200, first.content
    cursor = _cursor_from_next(first.data["next"])

    resp = api_client.get(f"/api/comments/?cursor={cursor}")
    assert resp.status_code == 400, resp.content


def test_unknown_pagination_mode_is_a_400(api_client, keeper):
    """A typo'd mode (`pagination=cusor`) must not silently degrade to
    numbered pages; mirrors zPageView's loud failure."""
    _standalone(keeper, "BOGUS-MODE-BODY")
    resp = api_client.get("/api/comments/?pagination=cusor")
    assert resp.status_code == 400, resp.content


def test_cursor_mode_cannot_resurface_a_deactivated_authors_post(
    api_client, poster, keeper,
):
    """The cursor paginator re-orders and slices the queryset the view hands
    it; it must never be handed anything wider. Deactivation mid-scroll must
    take the author's posts off the NEXT page too."""
    hidden = [_standalone(poster, f"CURSOR-GONE-{i}") for i in range(3)]
    shown = [_standalone(keeper, f"CURSOR-STAYS-{i}") for i in range(3)]

    first = api_client.get("/api/comments/?pagination=cursor&page_size=2")
    assert first.status_code == 200, first.content
    # Control: while active, page one is the two newest, both the keeper's.
    assert [c["uuid"] for c in first.data["results"]] == [
        str(shown[2].uuid), str(shown[1].uuid)]

    _deactivate(poster)

    rest = _walk(api_client, first.data["next"])
    assert set(rest) == {str(shown[0].uuid)}
    for post in hidden:
        assert str(post.uuid) not in rest


# --------------------------------------------------------------------------
# ?parent__isnull= -- the microblog-only filter
# --------------------------------------------------------------------------


def test_microblog_only_excludes_replies_with_a_control(api_client, keeper):
    parent = _standalone(keeper, "MICRO-PARENT-BODY")
    reply = Comment.objects.create(
        author=keeper, content="MICRO-REPLY-BODY", parent=parent)

    # Control: unfiltered, the reply really is in the visible set.
    control = api_client.get("/api/comments/")
    assert control.status_code == 200, control.content
    assert {str(parent.uuid), str(reply.uuid)} <= _uuids(control)

    filtered = api_client.get("/api/comments/?parent__isnull=true")
    assert filtered.status_code == 200, filtered.content
    assert _uuids(filtered) == {str(parent.uuid)}
    assert b"MICRO-REPLY-BODY" not in filtered.content

    # The inverse is expressible too, and is the mirror image.
    replies = api_client.get("/api/comments/?parent__isnull=false")
    assert replies.status_code == 200, replies.content
    assert _uuids(replies) == {str(reply.uuid)}


def test_microblog_only_composes_with_cursor_mode(api_client, keeper):
    """The profile Posts tab sends exactly this combination."""
    parents = [_standalone(keeper, f"MICRO-CURSOR-{i}") for i in range(3)]
    for parent in parents:
        Comment.objects.create(
            author=keeper, content="MICRO-CURSOR-REPLY", parent=parent)

    seen = _walk(
        api_client,
        "/api/comments/?pagination=cursor&page_size=2&parent__isnull=true",
    )
    assert set(seen) == {str(p.uuid) for p in parents}
    assert len(seen) == 3


def test_microblog_only_needs_both_halves_not_just_parent_isnull(
    api_client, keeper, creator_factory,
):
    """`parent IS NULL` alone is NOT "a microblog post".

    A first-level comment on a zPage or an AI conversation also has no parent;
    what distinguishes standalone converse content is ``content_type IS NULL``
    (`visibility.py`). A posts-only feed built on ``parent__isnull`` alone
    therefore still interleaves article comments -- the exact interleaving the
    filter exists to remove.
    """
    owner = creator_factory(username="microblogpageowner")
    post = _standalone(keeper, "MICRO-STANDALONE-BODY")
    remark = _zpage_root_comment(keeper, owner, "MICRO-ARTICLE-COMMENT")

    # Control: `parent__isnull` is literal and says what it means -- the
    # article comment has no parent, so it matches. This is the bug, stated as
    # a passing assertion so a future change to that filter is visible here.
    half = api_client.get("/api/comments/?parent__isnull=true")
    assert half.status_code == 200, half.content
    assert {str(post.uuid), str(remark.uuid)} <= _uuids(half)

    # Both halves together are what "microblog only" means, and the article
    # comment is gone.
    both = api_client.get(
        "/api/comments/?parent__isnull=true&content_type__isnull=true")
    assert both.status_code == 200, both.content
    assert _uuids(both) == {str(post.uuid)}
    assert b"MICRO-ARTICLE-COMMENT" not in both.content

    #...and the inverse selects the attached comments, so the filter is not
    # simply refusing everything.
    attached = api_client.get("/api/comments/?content_type__isnull=false")
    assert attached.status_code == 200, attached.content
    assert _uuids(attached) == {str(remark.uuid)}


def test_profile_posts_tab_excludes_the_creators_article_comments(
    api_client, poster, creator_factory,
):
    """The per-creator surface is the creator's POSTS, not every root comment
    they have ever left under somebody's article."""
    owner = creator_factory(username="tabpageowner")
    post = _standalone(poster, "TAB-STANDALONE")
    remark = _zpage_root_comment(poster, owner, "TAB-ARTICLE-COMMENT")

    control = api_client.get("/api/comments/?author=streamposter")
    assert control.status_code == 200, control.content
    assert {str(post.uuid), str(remark.uuid)} == _uuids(control)

    seen = _walk(
        api_client,
        "/api/comments/?pagination=cursor&page_size=2&author=streamposter"
        "&parent__isnull=true&content_type__isnull=true",
    )
    assert seen == [str(post.uuid)]


def test_microblog_only_cannot_resurface_a_deactivated_authors_post(
    api_client, poster,
):
    _standalone(poster, "MICRO-GONE-BODY")
    control = api_client.get("/api/comments/?parent__isnull=true")
    assert control.status_code == 200, control.content
    assert b"MICRO-GONE-BODY" in control.content

    _deactivate(poster)

    resp = api_client.get("/api/comments/?parent__isnull=true")
    assert resp.status_code == 200, resp.content
    assert resp.data["results"] == []


# --------------------------------------------------------------------------
# ?author= -- the per-creator surface
# --------------------------------------------------------------------------


def test_author_filter_matches_case_insensitively_and_stays_scoped(
    api_client, poster, keeper,
):
    mine = _standalone(poster, "AUTHOR-MINE-BODY")
    theirs = _standalone(keeper, "AUTHOR-THEIRS-BODY")

    # Profile links are built from the displayed username, so the filter is
    # iexact on purpose: any casing of the same name is the same creator.
    for username in ("streamposter", "StreamPoster", "STREAMPOSTER"):
        resp = api_client.get(f"/api/comments/?author={username}")
        assert resp.status_code == 200, resp.content
        assert _uuids(resp) == {str(mine.uuid)}
        assert str(theirs.uuid) not in _uuids(resp)

    # Visibility control: filtering by author may not resurface a deactivated
    # author's corpus -- same gate as every other path through this endpoint.
    _deactivate(poster)

    resp = api_client.get("/api/comments/?author=STREAMPOSTER")
    assert resp.status_code == 200, resp.content
    assert resp.data["results"] == []
    assert b"AUTHOR-MINE-BODY" not in resp.content


def test_author_filter_is_exact_not_a_prefix_or_substring(
    api_client, creator_factory,
):
    """`?author=stream` must not fan out to streamposter AND streamkeeper:
    a profile shows one creator's posts."""
    short = creator_factory(username="stream")
    longer = creator_factory(username="streamer")
    mine = _standalone(short, "AUTHOR-EXACT-MINE")
    _standalone(longer, "AUTHOR-EXACT-OTHER")

    resp = api_client.get("/api/comments/?author=stream")
    assert resp.status_code == 200, resp.content
    assert _uuids(resp) == {str(mine.uuid)}


def test_profile_posts_tab_query_composes_all_three(
    api_client, poster, keeper,
):
    """author + parent__isnull + cursor: the exact request the Posts tab
    sends, walked to the end."""
    mine = [_standalone(poster, f"TAB-MINE-{i}") for i in range(3)]
    for post in mine:
        Comment.objects.create(
            author=poster, content="TAB-MINE-REPLY", parent=post)
    _standalone(keeper, "TAB-THEIRS")

    seen = _walk(
        api_client,
        "/api/comments/?pagination=cursor&page_size=2"
        "&author=StreamPoster&parent__isnull=1&content_type__isnull=1",
    )
    assert seen == [str(p.uuid) for p in reversed(mine)]
