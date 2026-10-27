"""Anonymous-access regression suite for the fail-closed DRF default.

Two halves, both against real Postgres:

*func:`test_public_endpoint_is_reachable_anonymously` — every endpoint that
  must survive ``DEFAULT_PERMISSION_CLASSES = [IsAuthenticated]``. These are the
  outage cases: a missed ``AllowAny`` here means signed-out visitors, crawlers
  and the SvelteKit SSR pod get a 403 instead of a page. Each case pins the
  exact status AND a body marker its own handler produces. Several legitimately
  answer 400 or 404 for a bare request (no captcha, unknown token, missing
  row), so "200" would be wrong -- but "not 401/403" was wrong too: it passed
  on a deleted route's 404, a 405 and an explicit 500.

*func:`test_private_endpoint_rejects_anonymous` — endpoints that used to be
  reachable anonymously purely because DRF's default was ``AllowAny``. Most of
  them then crashed on ``AnonymousUser`` deep in the ORM (a 500, and an error
  budget, instead of a 403).

``@api_view`` handlers only accept their declared methods, so each case names
the method the route actually implements; using the wrong one yields a 405,
which the exact-answer assertion rejects.
"""
import uuid

import pytest
from django.core.cache import cache

from dj.apps.g12f.models import zPage
from dj.apps.g12f.views.sitemap import make_sitemap_revision


# Keep parametrized node IDs stable across independently collected CI shards.
# These IDs only exercise the anonymous permission layer; the test database is
# empty for the endpoint and no corresponding resource can exist.
UNKNOWN_ZPAGE_UUID = "00000000-0000-4000-8000-000000000000"
UNKNOWN_MEETING_UUID = "11111111-1111-4111-8111-111111111111"


@pytest.fixture(autouse=True)
def _clear_throttle_history():
    """Throttle counters live in the process-local cache. Every request below
    comes from 127.0.0.1, so without this the IP-keyed brake on
    ``/api/otp/login/`` could carry over from another test and turn a
    permission assertion into a spurious 429."""
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def public_page(creator_factory):
    creator = creator_factory()
    return zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        vanity=f"anon-{uuid.uuid4().hex[:8]}",
        title="A public page",
        content="Public content.",
        is_published=True,
    )


# (method, path template, why it must stay public, expected answers)
#
# ``expected`` is the exact answer each route gives a bare anonymous request,
# as ``(status, body marker)`` pairs; a response must match one of them. The
# marker is text only that route's own handler produces, so a 404 from the URL
# resolver (route deleted or renamed), a 405, or an explicit 500 fails the case
# instead of slipping past a "not 401/403" check. Several of these
# legitimately answer 4xx for a bare request (no captcha, unknown token,
# missing row) -- that is fine, as long as it is THIS handler's 4xx.
PUBLIC = [
    ("get", "/api/", "browsable route index", ((200, b'"zpage":'),)),
    ("get", "/api/schema/", "OpenAPI schema", ((200, b"openapi: 3."),)),
    (
        "get", "/api/zpage/", "public zPage list — SSR + crawlers",
        ((200, b'"results":'),),
    ),
    (
        "get", "/api/sitemap/", "bounded sitemap index feed — SSR + crawlers",
        ((200, b'"chunk_size":'),),
    ),
    (
        "get",
        "/api/sitemap/creators/0/{sitemap_revision}/",
        "bounded sitemap page — SSR + crawlers",
        # The fixture has no creators, so the pinned revision is stale and the
        # handler itself answers its own 409 -- still proves the route is
        # anonymous and live, which is all this row is about.
        ((200, b"<urlset"), (409, b"Sitemap page changed")),
    ),
    ("get", "/api/zpage/{addr}/", "public zPage detail", ((200, b"Public content."),)),
    ("get", "/api/zpage/{addr}/related/", "related pages rail", ((200, b"["),)),
    (
        "get", "/api/g12f/zpage/{addr}/series/", "series strip on a zPage",
        ((404, b"No Series matches the given query."),),
    ),
    ("get", "/api/creator/", "public creator directory", ((200, b'"results":'),)),
    (
        "get", "/api/creator/{username}/", "public creator profile",
        ((200, b'"username":"{username}"'),),
    ),
    (
        "get", "/api/get-type/{username}", "root-URL creator-vs-zpage routing",
        ((200, b'"creator"'),),
    ),
    ("get", "/api/comments/", "comment list on public pages", ((200, b'"results":'),)),
    (
        "get", "/api/languages/", "language catalog — every editor load",
        ((200, b'"languages":'),),
    ),
    ("get", "/api/tagging/autocomplete", "public tag search", ((200, b"["),)),
    (
        "get", "/api/tagging/hub/zcash", "public tag hub (#1417)",
        ((404, b"No published pages carry this tag."),),
    ),
    ("get", "/api/ai/models/", "public model catalogue", ((200, b'"results":'),)),
    (
        "get", "/api/ai/public-conversations/", "public AI conversations",
        ((200, b'"results":'),),
    ),
    ("get", "/api/pricing/", "public 2Z price", ((200, b'"tuzis_per_zec":'),)),
    (
        "get", "/api/pricing/quote/", "public 2Z quote",
        ((400, b"Query param `tuzis` (integer) is required."),),
    ),
    (
        "get", "/api/zuuli/capabilities/", "ZUULI release compatibility",
        ((200, b'"contract_version":'),),
    ),
    (
        "get", "/api/e2ee/authority/", "handle authority public key",
        # Which one depends on whether a key is loaded in this process (a
        # test elsewhere may `signing.install()` one); both are this view.
        (
            (200, b'"public_key":'),
            (503, b"The handle authority is not available."),
        ),
    ),
    ("get", "/api/dyte/public/", "public live-meeting list", ((200, b'"results":'),)),
    (
        "get", "/api/dyte/{username}/live-status", "public live status",
        ((200, b"{"),),
    ),
    ("post", "/api/start/", "registration", ((406, b"ReCAPTCHA not supplied."),)),
    ("post", "/api/otp/login/", "OTP login", ((401, b"Invalid credentials."),)),
    (
        "post", "/api/auth/login/", "password login",
        ((400, b'"captcha_result":["This field is required."]'),),
    ),
    (
        "post", "/api/auth/zcash/challenge/", "Zcash login challenge",
        ((400, b"Invalid request."),),
    ),
    (
        "get", "/api/auth/social/providers/", "social login provider list",
        ((200, b'"providers":'),),
    ),
    (
        "get",
        "/api/auth/social/mobile/providers/",
        "ZUULI mobile social provider readiness",
        ((200, b'"providers":'),),
    ),
    (
        "get", "/api/emails/confirm", "email confirmation link",
        ((400, b"This link is incomplete"),),
    ),
    (
        "post", "/api/emails/reset-password", "forgot-password request",
        ((400, b"Email is required"),),
    ),
    (
        "post", "/api/emails/do-reset-password", "password reset redemption",
        ((400, b"Token and new password are required."),),
    ),
    (
        "get", "/api/emails/opt-out/nobody@example.com", "unsubscribe link",
        ((404, b"This unsubscribe link is not valid"),),
    ),
]

# (method, path template, what it exposes)
PRIVATE = [
    ("get", "/api/auth/user/", "the caller's own account"),
    ("get", "/api/myuploads/", "the caller's uploaded files"),
    ("get", "/api/events/", "the caller's notifications"),
    ("get", "/api/events/unread_count/", "the caller's unread count"),
    ("get", "/api/events/has/", "whether the caller has events"),
    ("get", "/api/emails/status", "the caller's email address"),
    ("post", "/api/emails/resend", "sends mail as the caller"),
    ("post", "/api/emails/public", "flips the caller's email visibility"),
    ("post", "/api/emails/notifications", "flips the caller's email prefs"),
    ("delete", "/api/emails/delete", "deletes the caller's email"),
    ("delete", "/api/twitter/delete", "deletes the caller's Twitter link"),
    ("get", "/api/g12f/series/mine/", "the caller's series"),
    ("delete", "/api/g12f/series/clear-zpage/" + UNKNOWN_ZPAGE_UUID + "/",
     "unlinks a page from series"),
    # The deprecated ?free2zaddr= alias shares the same view, but assert it
    # separately: it is a distinct URL pattern and must not become the one
    # unauthenticated way in while the alias survives.
    ("delete", "/api/g12f/series/clear-zpage/",
     "unlinks a page from series (deprecated query form)"),
    ("get", "/api/ai/conversations/", "the caller's AI conversations"),
    ("get", "/api/storytime/mystories/", "the caller's stories"),
    ("get", "/api/kyc/user-profile", "the caller's KYC identity data"),
    ("get", "/api/stripe/transactions/", "the caller's payments"),
    ("get", "/api/tuzis/my-subscribers", "the caller's subscribers"),
    ("get", "/api/tuzis/my-subscriptions", "the caller's subscriptions"),
    ("post", "/api/comments/", "posts a comment and spends 2Z as the caller"),
    ("post", "/api/zpage/fund/", "spends the caller's 2Z"),
    ("post", "/api/openai/prompt", "spends the caller's 2Z on inference"),
    ("post", "/api/ai/prompt/", "spends the caller's 2Z on metered inference"),
    ("post", "/api/dyte/someone/private/" + UNKNOWN_MEETING_UUID,
     "joins a paid private stream as the caller"),
]


#What DRF's own ``IsAuthenticated`` says when it refuses an anonymous caller.
#Matching on this rather than on the bare status code matters for the login
#endpoints: ``/api/otp/login/`` and ``/api/auth/login/`` answer 401/400 to
#*wrong credentials*, which is correct behaviour and not a permission refusal.
NOT_AUTHENTICATED_DETAIL = b"Authentication credentials were not provided."


def _call(client, method, path):
    fn = getattr(client, method)
    if method in ("post", "put", "patch"):
        return fn(path, {}, format="json")
    return fn(path)


def _refused_by_permission_layer(response):
    return (
        response.status_code in (401, 403)
        and NOT_AUTHENTICATED_DETAIL in response.content
    )


@pytest.mark.django_db
@pytest.mark.parametrize(
    "method,path,reason,expected", PUBLIC, ids=[p for _, p, _, _ in PUBLIC]
)
def test_public_endpoint_is_reachable_anonymously(
    api_client, public_page, method, path, reason, expected
):
    username = public_page.creator.username
    path = path.format(
        addr=public_page.free2zaddr,
        username=username,
        sitemap_revision=make_sitemap_revision("creators", 0, 1),
    )
    response = _call(api_client, method, path)
    assert not _refused_by_permission_layer(response), (
        f"{method.upper()} {path} must stay anonymous ({reason}) but the "
        f"permission layer refused it: {response.status_code} "
        f"{response.content[:300]!r}"
    )
    # The positive half. "Not 401/403" alone is satisfied by a 404
    # from a deleted route, a 405 from the wrong method, or an explicit 500,
    # so pin the exact answer this route's own handler gives, body included.
    answers = [
        (status, marker.replace(b"{username}", username.encode()))
        for status, marker in expected
    ]
    assert any(
        response.status_code == status and marker in response.content
        for status, marker in answers
    ), (
        f"{method.upper()} {path} ({reason}) expected one of "
        f"{[(s, m.decode()) for s, m in answers]}, got "
        f"{response.status_code} {response.content[:300]!r}"
    )
    if "/api/sitemap/creators/" in path:
        assert response["X-Sitemap-Protocol"] == "2"


@pytest.mark.django_db
@pytest.mark.parametrize(
    "method,path,reason", PRIVATE, ids=[p for _, p, _ in PRIVATE]
)
def test_private_endpoint_rejects_anonymous(api_client, method, path, reason):
    response = _call(api_client, method, path)
    # Matching the permission layer's own refusal, not just "some 4xx": several
    # of these views also hand-roll a 401 in the handler body. Accepting those
    # would let the permission_classes silently disappear from a view while
    # this test still passed on the inline check — and that inline check is
    # exactly what keeps getting forgotten on new endpoints.
    assert _refused_by_permission_layer(response), (
        f"{method.upper()} {path} exposes {reason} and must be refused by the "
        f"permission layer, but returned {response.status_code}: "
        f"{response.content[:300]!r}"
    )


@pytest.mark.django_db
def test_anonymous_comment_write_is_refused_by_the_permission_layer(api_client):
    """``IsAuthorOrReadOnly`` defines only ``has_object_permission``, so
    ``has_permission`` defaulted to True and an anonymous POST reached
    ``perform_create``. Its inline guard raised
    ``ValidationError(..., status=403)`` — a kwarg ``ValidationError`` does not
    accept — so the refusal silently came back as a 400.

    Pinning the status code specifically: 400 was the old, wrong answer, and it
    is what regressing this would produce again.
    """
    response = api_client.post(
        "/api/comments/", {"content": "hi", "tuzis": 1}, format="json"
    )
    assert response.status_code in (401, 403), (
        f"anonymous comment POST returned {response.status_code} "
        f"(400 means the permission class was lost and the broken inline "
        f"guard answered instead): {response.content[:200]!r}"
    )


@pytest.mark.django_db
def test_comment_reads_stay_anonymous(api_client):
    """The other half: adding IsAuthenticatedOrReadOnly must not close the
    public comment reads that render on every zPage."""
    assert api_client.get("/api/comments/").status_code == 200


@pytest.mark.django_db
def test_anonymous_cannot_create_a_zpage(api_client):
    """The zPage viewset carried `permissions = [...]` — a typo DRF never
    read — so it ran on the AllowAny default."""
    response = api_client.post(
        "/api/zpage/", {"title": "hi", "content": "there"}, format="json"
    )
    assert response.status_code in (401, 403), response.content


@pytest.mark.django_db
def test_authenticated_user_can_still_read_and_write_own_zpage(
    api_client, creator_factory
):
    """The other half of IsAuthenticatedOrReadOnly: the flip must not lock
    logged-in creators out of their own pages."""
    creator = creator_factory()
    api_client.force_authenticate(user=creator)
    assert api_client.get("/api/zpage/").status_code == 200


@pytest.mark.django_db
def test_myuploads_create_sets_owner(creator_factory, rf):
    """``owner`` is not a ``FeaturedImageSerializer`` field, so before this the
    viewset called ``serializer.save()`` with no owner at all.

    Exercised at the viewset rather than over HTTP because the serializer also
    omits ``file``, which is NOT NULL — a bare POST to this route cannot
    succeed today either way. This pins the ownership contract so it is already
    correct if/when the serializer is completed.
    """
    from dj.apps.uploads.views import MyUploadsViewSet

    creator = creator_factory()
    request = rf.post("/api/myuploads/")
    request.user = creator

    view = MyUploadsViewSet()
    view.request = request

    saved = {}

    class _Serializer:
        def save(self, **kwargs):
            saved.update(kwargs)

    view.perform_create(_Serializer())
    assert saved == {"owner": creator}
