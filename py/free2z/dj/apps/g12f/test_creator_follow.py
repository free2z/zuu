"""The free creator-follow API.

The contract these pin, in order of how much they would cost if they broke:

1. **Follow is not Subscription.** ``Subscription`` moves 2Z and grants
   subscriber entitlement; its DELETE only zeroes the renewal ceiling and
   leaves entitlement live until ``expires``. If a client wired a free "Follow"
   button to that model, following would charge money and unfollowing would not
   actually unfollow. So every write here is asserted to leave 2Z balances,
   Subscription rows and ``member_price`` untouched.
2. **Idempotency.** A double-clicked PUT must not create two rows or two
   different answers, and a DELETE of something already gone is a success.
3. **Existence is not leakable.** A creator that never existed and a creator
   that was deactivated answer identically, byte for byte.
4. **The counts and the list agree**, and the list pages without dropping or
   duplicating a row.
"""

from datetime import timedelta
from decimal import Decimal

import pytest
from django.db import IntegrityError, transaction
from knox.models import AuthToken
from django.utils import timezone
from rest_framework.test import APIClient

from dj.apps.g12f.models import CreatorFollow, Subscription


def _follow_url(username: str) -> str:
    return f"/api/creator/{username}/follow/"


MINE = "/api/g12f/follows/mine/"


@pytest.fixture
def authed(creator_factory):
    """(client, creator) for a signed-in caller."""
    me = creator_factory(username="follower-one")
    client = APIClient()
    client.force_authenticate(user=me)
    return client, me


# --------------------------------------------------------------------------
# Authentication
# --------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize("method", ["get", "put", "delete"])
def test_anonymous_callers_are_refused_on_every_method(
    api_client, creator_factory, method
):
    """No method on the follow route is anonymously reachable.

    Both 401 and 403 are accepted because which one DRF emits is decided by
    ``DEFAULT_AUTHENTICATION_CLASSES`` order, not by this view: DRF downgrades
    ``NotAuthenticated`` to 403 when the first authenticator publishes no
    ``WWW-Authenticate`` header, and ``SessionAuthentication`` is first
    project-wide. What this endpoint owns is that the caller is refused
    *before* anything is read or written, which the row assertion below is the
    real check for.
    """
    star = creator_factory(username="the-star")
    response = getattr(api_client, method)(_follow_url(star.username))
    assert response.status_code in (401, 403), response.content
    assert not CreatorFollow.objects.exists()


@pytest.mark.django_db
def test_anonymous_callers_cannot_list_follows(api_client):
    assert api_client.get(MINE).status_code in (401, 403)


@pytest.mark.django_db
def test_a_real_knox_token_can_follow_and_list(creator_factory):
    """The knox path is exercised for real, not via ``force_authenticate``.

    Every other authenticated test here uses
    ``APIClient.force_authenticate()``, which assigns ``request.user``
    directly and **skips ``DEFAULT_AUTHENTICATION_CLASSES`` entirely**. That
    pins ``IsAuthenticated``, but it cannot show that a caller presenting the
    credential ZUULI actually sends gets in -- and the generated spec promises
    ``knoxApiToken`` on these operations. So mint a real ``AuthToken`` and put
    it on the wire.

    ``AuthToken.objects.create`` fires the ``post_save`` receiver that stamps
    the account epoch, so this is the same token shape
    ``/api/token/login/`` hands out; a token the epoch check would refuse
    would fail here rather than pass.
    """
    me = creator_factory(username="knox-follower")
    star = creator_factory(username="the-star")
    _instance, token = AuthToken.objects.create(me)

    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Token {token}")

    created = client.put(_follow_url(star.username))
    assert created.status_code == 200, created.content
    assert created.data["following"] is True
    assert CreatorFollow.objects.filter(follower=me, creator=star).count() == 1

    listed = client.get(MINE)
    assert listed.status_code == 200, listed.content
    assert [row["username"] for row in listed.data["results"]] == ["the-star"]

    removed = client.delete(_follow_url(star.username))
    assert removed.status_code == 200, removed.content
    assert not CreatorFollow.objects.filter(follower=me).exists()

    # And the token is what is doing the work: drop it and the same client is
    # anonymous again, so this test cannot pass on ambient session state.
    client.credentials()
    assert client.get(MINE).status_code in (401, 403)


@pytest.mark.django_db
def test_a_real_session_login_can_follow_and_list(creator_factory):
    """The other promised path: ``cookieAuth`` via a real session cookie."""
    me = creator_factory(username="session-follower")
    star = creator_factory(username="the-star")

    client = APIClient()
    client.force_login(me)
    assert client.cookies.get("sessionid"), (
        "force_login must have set a session cookie for this to be testing "
        "SessionAuthentication rather than nothing"
    )

    created = client.put(_follow_url(star.username))
    assert created.status_code == 200, created.content
    assert created.data["following"] is True
    assert CreatorFollow.objects.filter(follower=me, creator=star).count() == 1

    listed = client.get(MINE)
    assert listed.status_code == 200, listed.content
    assert [row["username"] for row in listed.data["results"]] == ["the-star"]

    removed = client.delete(_follow_url(star.username))
    assert removed.status_code == 200, removed.content
    assert not CreatorFollow.objects.filter(follower=me).exists()

    client.logout()
    assert client.get(MINE).status_code in (401, 403)


# --------------------------------------------------------------------------
# Idempotency
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_put_creates_once_and_repeats_are_no_ops(authed, creator_factory):
    client, me = authed
    star = creator_factory(username="the-star")

    first = client.put(_follow_url(star.username))
    assert first.status_code == 200, first.content
    assert first.data["following"] is True
    assert first.data["username"] == "the-star"

    second = client.put(_follow_url(star.username))
    assert second.status_code == 200, second.content
    assert second.data == first.data, (
        "a repeated PUT must report the same state, not a second follow"
    )

    assert CreatorFollow.objects.filter(
        follower=me, creator=star,
    ).count() == 1


@pytest.mark.django_db
def test_delete_removes_once_and_repeats_are_no_ops(authed, creator_factory):
    client, me = authed
    star = creator_factory(username="the-star")
    CreatorFollow.objects.create(follower=me, creator=star)

    first = client.delete(_follow_url(star.username))
    assert first.status_code == 200, first.content
    assert first.data["following"] is False
    assert not CreatorFollow.objects.filter(follower=me).exists()

    # Unfollowing something already gone is a success, not a 404: the caller's
    # desired state is already true.
    second = client.delete(_follow_url(star.username))
    assert second.status_code == 200, second.content
    assert second.data == first.data


@pytest.mark.django_db
def test_get_reports_persisted_state_from_a_fresh_client(
    authed, creator_factory
):
    """State survives the request that made it — it is a row, not a session."""
    client, me = authed
    star = creator_factory(username="the-star")
    client.put(_follow_url(star.username))

    fresh = APIClient()
    fresh.force_authenticate(user=me)
    response = fresh.get(_follow_url(star.username))
    assert response.status_code == 200, response.content
    assert response.data["following"] is True

    # And it is per-viewer: somebody else looking at the same creator sees
    # their own answer, not this one.
    other = APIClient()
    other.force_authenticate(user=creator_factory(username="somebody-else"))
    assert other.get(_follow_url(star.username)).data["following"] is False


@pytest.mark.django_db
def test_the_path_segment_is_case_insensitive_and_the_answer_is_canonical(
    authed, creator_factory
):
    """`username__iexact` resolves the row; the response echoes the real name.

    Echoing the caller's casing back would hand a client a key that does not
    match the profile route it has to link to.
    """
    client, _me = authed
    creator_factory(username="MixedCase")

    response = client.put(_follow_url("mixedcase"))
    assert response.status_code == 200, response.content
    assert response.data["username"] == "MixedCase"


# --------------------------------------------------------------------------
# Self-follow
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_self_follow_is_refused_and_creates_no_row(authed):
    client, me = authed
    response = client.put(_follow_url(me.username))
    assert response.status_code == 400, response.content
    assert not CreatorFollow.objects.exists()

    # The GET is not an error — it just always answers false.
    state = client.get(_follow_url(me.username))
    assert state.status_code == 200, state.content
    assert state.data["following"] is False


@pytest.mark.django_db
def test_the_database_refuses_a_self_follow_too(creator_factory):
    """The view is not the only writer; admin and shell reach the model."""
    me = creator_factory(username="solipsist")
    with pytest.raises(IntegrityError):
        with transaction.atomic():
            CreatorFollow.objects.create(follower=me, creator=me)


@pytest.mark.django_db
def test_the_database_refuses_a_duplicate_pair(authed, creator_factory):
    _client, me = authed
    star = creator_factory(username="the-star")
    CreatorFollow.objects.create(follower=me, creator=star)
    with pytest.raises(IntegrityError):
        with transaction.atomic():
            CreatorFollow.objects.create(follower=me, creator=star)


# --------------------------------------------------------------------------
# Existence is not leakable
# --------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize("method", ["get", "put", "delete"])
def test_missing_and_deactivated_creators_are_indistinguishable(
    authed, creator_factory, method
):
    client, _me = authed
    banned = creator_factory(username="banned-star")
    banned.is_active = False
    banned.save(update_fields=["is_active", "updated_at"])

    gone = getattr(client, method)(_follow_url("banned-star"))
    never = getattr(client, method)(_follow_url("no-such-creator-at-all"))

    assert gone.status_code == 404, gone.content
    assert never.status_code == 404, never.content
    assert gone.data == never.data, (
        "a deactivated account must not be distinguishable from one that "
        "never existed — that is an existence oracle over the takedown list"
    )
    assert not CreatorFollow.objects.exists()


# --------------------------------------------------------------------------
# Counts
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_counts_match_the_follow_graph(authed, creator_factory):
    client, me = authed
    star = creator_factory(username="the-star")

    followers = [creator_factory(username=f"fan-{i}") for i in range(4)]
    for fan in followers:
        CreatorFollow.objects.create(follower=fan, creator=star)
    # The star follows two creators of their own; direction matters.
    for i in range(2):
        CreatorFollow.objects.create(
            follower=star, creator=creator_factory(username=f"idol-{i}"),
        )

    before = client.get(_follow_url(star.username))
    assert before.data["follower_count"] == 4
    assert before.data["following_count"] == 2
    assert before.data["following"] is False

    # The caller's own action is reflected in the count it gets back, so a
    # client never has to guess whether to add one locally.
    after = client.put(_follow_url(star.username))
    assert after.data["follower_count"] == 5
    assert after.data["following"] is True
    assert after.data["following_count"] == 2

    removed = client.delete(_follow_url(star.username))
    assert removed.data["follower_count"] == 4


@pytest.mark.django_db
def test_deactivated_accounts_drop_out_of_both_counts(
    authed, creator_factory
):
    client, _me = authed
    star = creator_factory(username="the-star")
    ghost = creator_factory(username="ghost-fan")
    CreatorFollow.objects.create(follower=ghost, creator=star)
    CreatorFollow.objects.create(
        follower=star, creator=creator_factory(username="ghost-idol"),
    )

    assert client.get(_follow_url(star.username)).data == {
        "username": "the-star", "following": False,
        "follower_count": 1, "following_count": 1,
    }

    for username in ("ghost-fan", "ghost-idol"):
        account = type(star).objects.get(username=username)
        account.is_active = False
        account.save(update_fields=["is_active", "updated_at"])

    after = client.get(_follow_url(star.username))
    assert after.data["follower_count"] == 0, (
        "a banned account must not keep inflating somebody's follower count"
    )
    assert after.data["following_count"] == 0


# --------------------------------------------------------------------------
# "Creators I follow"
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_my_follow_list_is_mine_only_and_paginates(authed, creator_factory):
    client, me = authed
    stars = [creator_factory(username=f"star-{i:02d}") for i in range(5)]
    for star in stars:
        CreatorFollow.objects.create(follower=me, creator=star)

    # Somebody else's follows are never in my list.
    stranger = creator_factory(username="stranger")
    CreatorFollow.objects.create(
        follower=stranger, creator=creator_factory(username="their-star"),
    )

    page1 = client.get(MINE, {"page_size": 2})
    assert page1.status_code == 200, page1.content
    assert page1.data["count"] == 5
    assert len(page1.data["results"]) == 2
    assert page1.data["next"] is not None

    page2 = client.get(MINE, {"page_size": 2, "page": 2})
    page3 = client.get(MINE, {"page_size": 2, "page": 3})
    seen = [
        row["username"]
        for page in (page1, page2, page3)
        for row in page.data["results"]
    ]
    assert sorted(seen) == sorted(s.username for s in stars), (
        "paging dropped or duplicated a row"
    )
    assert page3.data["next"] is None

    # Newest first, so the most recent follow leads.
    assert seen[0] == "star-04"

    assert set(page1.data["results"][0]) == {
        "username", "full_name", "created_at",
    }


@pytest.mark.django_db
def test_the_list_count_matches_following_count(authed, creator_factory):
    """The two endpoints must not disagree about the same number."""
    client, me = authed
    for i in range(3):
        CreatorFollow.objects.create(
            follower=me, creator=creator_factory(username=f"star-{i}"),
        )
    dropped = creator_factory(username="dropped-star")
    CreatorFollow.objects.create(follower=me, creator=dropped)
    dropped.is_active = False
    dropped.save(update_fields=["is_active", "updated_at"])

    listed = client.get(MINE)
    # The caller's OWN follow route: `following_count` there describes the
    # creator in the path, and for my own username that is this same list.
    state = client.get(_follow_url(me.username))
    assert listed.data["count"] == 3
    assert state.data["following_count"] == listed.data["count"]
    assert "dropped-star" not in [
        row["username"] for row in listed.data["results"]
    ]


# --------------------------------------------------------------------------
# Follow is not Subscription
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_following_never_touches_money_or_subscriptions(
    authed, creator_factory
):
    client, me = authed
    star = creator_factory(username="the-star", member_price=Decimal("25"))
    expires = timezone.now() + timedelta(days=10)
    sub = Subscription.objects.create(
        star=star, fan=me, expires=expires, max_price=Decimal("25"),
    )

    my_balance = me.tuzis
    star_balance = star.tuzis

    assert client.put(_follow_url(star.username)).status_code == 200
    assert client.delete(_follow_url(star.username)).status_code == 200

    me.refresh_from_db()
    star.refresh_from_db()
    sub.refresh_from_db()

    assert me.tuzis == my_balance, "following charged the follower 2Z"
    assert star.tuzis == star_balance
    assert Subscription.objects.count() == 1
    assert sub.expires == expires, "unfollowing shortened a paid subscription"
    assert sub.max_price == Decimal("25"), (
        "unfollowing cancelled a paid subscription's renewal"
    )
    assert star.member_price == Decimal("25")


@pytest.mark.django_db
def test_a_paid_subscription_does_not_imply_a_follow(authed, creator_factory):
    """The two relationships are independent in both directions."""
    client, me = authed
    star = creator_factory(username="the-star")
    Subscription.objects.create(
        star=star, fan=me, expires=timezone.now() + timedelta(days=10),
    )
    assert client.get(_follow_url(star.username)).data["following"] is False
    assert client.get(_follow_url(star.username)).data["follower_count"] == 0


# --------------------------------------------------------------------------
# The URL never carries mutable state
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_query_parameters_cannot_steer_the_write(authed, creator_factory):
    """: a query parameter selects a representation, it never mutates.

    A body is not accepted either — the pair IS the state — so a client that
    posts ``{"following": false}`` to the PUT still gets a follow, and a
    ``?following=false`` on the URL changes nothing.
    """
    client, me = authed
    star = creator_factory(username="the-star")

    response = client.put(
        _follow_url(star.username) + "?following=false&creator=someone-else",
        {"following": False, "creator": "someone-else", "follower": "admin"},
        format="json",
    )
    assert response.status_code == 200, response.content
    assert response.data["following"] is True
    assert list(
        CreatorFollow.objects.values_list("follower__username",
                                          "creator__username")
    ) == [(me.username, star.username)]


@pytest.mark.django_db
@pytest.mark.parametrize("method", ["get", "put", "delete"])
def test_directory_filters_cannot_404_the_follow_route(
    authed, creator_factory, method
):
    """The codex adversarial review finding on, pinned.

    ``CreatorView`` carries the public directory's filter backends, and DRF
    runs ``filter_queryset()`` inside ``get_object()`` — on detail routes too.
    So ``?min_followers=1`` (which counts PAID subscribers), ``?search=`` or
    ``?ordering=`` could exclude a perfectly valid target and answer 404, and
    the *unfollow* case is the bad one: the caller is told the creator does not
    exist while the follow they asked to remove is still there.

    A creator with zero paid subscribers, no matching search text and no
    verification is exactly the row every one of those filters drops.
    """
    client, me = authed
    star = creator_factory(username="unfiltered-star", full_name="")
    CreatorFollow.objects.create(follower=me, creator=star)
    assert not Subscription.objects.filter(star=star).exists()

    url = (
        _follow_url(star.username)
        + "?min_followers=1&search=nothing-matches-this&ordering=-total"
        "&is_verified=true"
    )
    response = getattr(client, method)(url)
    assert response.status_code == 200, response.content
    assert response.data["username"] == "unfiltered-star"

    if method == "delete":
        assert not CreatorFollow.objects.filter(
            follower=me, creator=star,
        ).exists(), (
            "the unfollow reported success but a query parameter had already "
            "made it a no-op"
        )


@pytest.mark.django_db
@pytest.mark.parametrize("method", ["get", "put", "delete"])
def test_dotted_usernames_can_use_the_follow_api(
    authed, creator_factory, method
):
    """Second codex adversarial review finding on, pinned.

    Django's ``UnicodeUsernameValidator`` allows ``. @ + - _``, and nothing in
    this project narrows that, so ``alice.smith`` is a real, creatable account
    with a working profile — ``/api/creator/alice.smith/`` resolves through the
    explicit ``creator_dumbass`` path, which uses ``<str:...>``.

    A DRF router's detail regex defaults to ``[^/.]+``, so without an explicit
    ``lookup_value_regex`` the router-generated follow route silently accepts a
    strictly smaller set of usernames than the profile route next to it: every
    method 404s for a creator whose profile page works. The unfollow case is
    the one that hurts — rename into a dotted username and your existing
    followers can no longer remove the relationship.
    """
    client, me = authed
    star = creator_factory(username="alice.smith")
    CreatorFollow.objects.create(follower=me, creator=star)

    # The premise: the profile route really does serve this creator.
    assert client.get("/api/creator/alice.smith/").status_code == 200

    response = getattr(client, method)(_follow_url("alice.smith"))
    assert response.status_code == 200, response.content
    assert response.data["username"] == "alice.smith"
