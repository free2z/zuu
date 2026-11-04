"""Structural guard for the fail-closed DRF permission default.

``REST_FRAMEWORK['DEFAULT_PERMISSION_CLASSES']`` is ``IsAuthenticated``. That
backstop only helps if nobody *relies* on it: a view that silently inherits the
default is a view whose author never decided whether it should be public, and
flipping the default again (in either direction) would move it without anyone
noticing.

So this walks the live URLconf and asserts, for every DRF view it can reach:

1. ``permission_classes`` is declared explicitly somewhere in the view's own
   MRO — not inherited from ``rest_framework.views.APIView``.
2. No view carries a ``permissions`` attribute. ``zPageView`` shipped
   ``permissions = [IsAuthenticatedOrReadOnly]`` for years; DRF has never read
   that name, so the viewset ran wide open while looking protected.
3. No *non*-DRF view (plain ``django.views.View``) carries
   ``permission_classes`` either — inert there for the same reason, which is
   how ``zPageClearView`` came to have an unenforced one.

These are cheap, they need no database, and they are the reason a new view
cannot regress the audit in  without CI saying so.
"""
import pytest
from django.urls import URLPattern, URLResolver, get_resolver
from rest_framework.views import APIView


def _iter_view_classes():
    """Yield (route, view_class) for every pattern in the root URLconf."""
    seen = set()

    def walk(resolver, prefix=""):
        for pattern in resolver.url_patterns:
            if isinstance(pattern, URLResolver):
                yield from walk(pattern, prefix + str(pattern.pattern))
            elif isinstance(pattern, URLPattern):
                yield prefix + str(pattern.pattern), pattern.callback

    for route, callback in walk(get_resolver()):
        # DRF's @api_view builds a throwaway APIView subclass and hangs it off
        # the function as `.cls`; class-based views expose `.view_class`.
        cls = getattr(callback, "cls", None) or getattr(
            callback, "view_class", None
        )
        if cls is None:
            continue
        key = (cls.__module__, cls.__qualname__, route)
        if key in seen:
            continue
        seen.add(key)
        yield route, cls


def _declaring_class(cls, attr):
    """The class in ``cls``'s MRO that actually defines ``attr``, or None."""
    for klass in cls.__mro__:
        if attr in klass.__dict__:
            return klass
    return None


def _drf_views():
    return [
        (route, cls)
        for route, cls in _iter_view_classes()
        if issubclass(cls, APIView)
    ]


def test_urlconf_exposes_drf_views():
    """Sanity check: the walker actually finds the API, so the asserts below
    are not vacuously passing on an empty list."""
    assert len(_drf_views()) > 50


def test_every_drf_view_declares_permission_classes():
    offenders = sorted(
        f"{cls.__module__}.{cls.__qualname__} (at /{route})"
        for route, cls in _drf_views()
        if _declaring_class(cls, "permission_classes") is APIView
    )
    assert not offenders, (
        "These DRF views inherit DEFAULT_PERMISSION_CLASSES instead of "
        "declaring their own. Decide explicitly and say so on the class: "
        "[AllowAny] / [IsAuthenticatedOrReadOnly] / [IsAuthenticated].\n  "
        + "\n  ".join(offenders)
    )


def test_no_view_uses_the_inert_permissions_attribute():
    offenders = sorted(
        f"{cls.__module__}.{cls.__qualname__} (at /{route})"
        for route, cls in _iter_view_classes()
        if _declaring_class(cls, "permissions") is not None
    )
    assert not offenders, (
        "`permissions = [...]` is not a DRF setting and enforces nothing. "
        "Rename it to `permission_classes`.\n  " + "\n  ".join(offenders)
    )


def test_non_drf_views_do_not_pretend_to_have_permissions():
    offenders = sorted(
        f"{cls.__module__}.{cls.__qualname__} (at /{route})"
        for route, cls in _iter_view_classes()
        if not issubclass(cls, APIView)
        and _declaring_class(cls, "permission_classes") is not None
    )
    assert not offenders, (
        "`permission_classes` on a plain django.views.View is inert. Either "
        "make it a DRF APIView or enforce auth in the view itself.\n  "
        + "\n  ".join(offenders)
    )


#``@action(permission_classes=[...])`` overrides the viewset's own
#permissions for that one route, and it lives in the decorator's initkwargs
#rather than on the class — so the fallthrough check above cannot see it. A
#single ``@action(..., permission_classes=[AllowAny])`` on an otherwise
#private viewset would therefore reopen a hole invisibly. Pinning the full
#set means adding one forces a deliberate edit here.
EXPECTED_ACTION_PERMISSION_OVERRIDES = {
    # Public "related pages" rail on a zPage — anonymous by design.
    ("dj.apps.g12f.views.zpage", "zPageView", "related"): ["AllowAny"],
    # Owner-only translation writes; readers use the ordinary retrieve route.
    ("dj.apps.g12f.views.zpage", "zPageView", "translation"): [
        "IsAuthenticated"
    ],
    #. The free follow toggle on an otherwise PUBLIC creator viewset:
    # GET/PUT/DELETE /api/creator/{username}/follow/ all run through this one
    # `@action`, so this single entry closes all three. It must never become
    # AllowAny -- `following` is viewer-specific and the write is attributed
    # to `request.user` alone.
    ("dj.apps.g12f.views.creator", "CreatorView", "follow"): [
        "IsAuthenticated"
    ],
    # Recipient-side notification controls are viewer-specific and must not
    # inherit the public creator-directory permission.
    ("dj.apps.g12f.views.creator", "CreatorView", "block"): [
        "IsAuthenticated"
    ],
    ("dj.apps.g12f.views.creator", "CreatorView", "mute"): [
        "IsAuthenticated"
    ],
}


def test_action_level_permission_overrides_are_pinned():
    found = {}
    for _, cls in _iter_view_classes():
        get_extra_actions = getattr(cls, "get_extra_actions", None)
        if get_extra_actions is None:
            continue
        for action in get_extra_actions():
            perms = action.kwargs.get("permission_classes")
            if perms is None:
                continue
            key = (cls.__module__, cls.__qualname__, action.__name__)
            found[key] = [p.__name__ for p in perms]

    assert found == EXPECTED_ACTION_PERMISSION_OVERRIDES, (
        "The set of @action-level permission overrides changed. These bypass "
        "the viewset's permission_classes for a single route and are invisible "
        "to the fallthrough check, so each one needs a deliberate decision.\n"
        f"  found:    {found}\n"
        f"  expected: {EXPECTED_ACTION_PERMISSION_OVERRIDES}"
    )


#Every DRF view that accepts an OAuth 2.0 access token, pinned with
#the scopes it demands. ``OAuth2JWTAuthentication`` is in the global
#default list and is DEFAULT-DENY: a view that does not declare
#``required_scopes`` refuses every OAuth token. So this set is the entire
#surface a third-party app can reach with a token, and adding to it is a
#deliberate decision made here, next to the permission audit it extends.
EXPECTED_OAUTH_SCOPED_VIEWS = {
    ("dj.apps.oidc.views", "UserInfoView"): ["openid"],
    # zuu purchase.md §1: `purchase:create` covers creating an intent and
    # reading the intents THIS app created (the read is scoped to the
    # token's application in `_owned_intents`)..
    ("dj.apps.purchases.views", "PurchaseIntentCreateView"): ["purchase:create"],
    ("dj.apps.purchases.views", "PurchaseIntentDetailView"): ["purchase:create"],
    # zuu purchase.md §1.1: the caller's own balance, read-only.
    ("dj.apps.purchases.balance", "BalanceView"): ["balance:read"],
    # Only the bearer token's own current AI grant; no session/Knox or
    # caller-selected account/application. docs/free2z/sdk/GRANTS.md.
    ("dj.apps.oidc.sdk_grant", "SdkGrantView"): ["ai:invoke"],
    # The bearer's own report of one AI call it made through this same app
    # (store AI-content policy). Writes a moderation row, never money; an
    # unowned call id is the same 404 as an unknown one.
    ("dj.apps.oidc.ai_reports", "SdkCallReportView"): ["ai:invoke"],
}


def test_oauth_scoped_views_are_pinned():
    found = {
        (cls.__module__, cls.__qualname__): list(cls.required_scopes)
        for _, cls in _drf_views()
        if _declaring_class(cls, "required_scopes") is not None
    }
    assert found == EXPECTED_OAUTH_SCOPED_VIEWS, (
        "The set of views that accept OAuth access tokens changed. Each one "
        "is an endpoint a third-party app can call on a user's behalf, so "
        "each needs a deliberate decision recorded here.\n"
        f"  found:    {found}\n"
        f"  expected: {EXPECTED_OAUTH_SCOPED_VIEWS}"
    )


def test_no_view_overrides_get_permissions_unnoticed():
    """``get_permissions()`` can return anything at runtime, which would make
    the declarative audit meaningless for that view. There are none today;
    this fails if one appears so it gets reviewed rather than assumed benign."""
    from rest_framework.views import APIView as _APIView

    offenders = sorted(
        f"{cls.__module__}.{cls.__qualname__}"
        for _, cls in _iter_view_classes()
        if issubclass(cls, _APIView)
        and _declaring_class(cls, "get_permissions") is not _APIView
    )
    assert not offenders, (
        "These views compute permissions at runtime, so the declared "
        "permission_classes is not the whole story — review each:\n  "
        + "\n  ".join(offenders)
    )


@pytest.mark.parametrize(
    "dotted",
    [
        # A representative slice of the  inventory, pinned by name so a
        # future edit that quietly opens one of them fails here too.
        ("dj.apps.g12f.views.zpage", "zPageView", "IsAuthenticatedOrReadOnly"),
        ("dj.apps.g12f.views.creator", "CreatorView", "AllowAny"),
        ("dj.apps.g12f.views.creator", "SignUpView", "AllowAny"),
        ("dj.apps.uploads.views", "MyUploadsViewSet", "IsAuthenticated"),
        ("dj.apps.twitter.views", "TwitterDeleteView", "IsAuthenticated"),
        ("dj.apps.dyte.views", "PrivateMeeting", "IsAuthenticated"),
        ("dj.apps.emails.views", "DeleteEmailView", "IsAuthenticated"),
        (
            "dj.apps.comments.views",
            "CommentListCreateAPIView",
            "IsAuthenticatedOrReadOnly",
        ),
    ],
)
def test_pinned_permissions(dotted):
    import importlib

    module, name, expected = dotted
    cls = getattr(importlib.import_module(module), name)
    assert [c.__name__ for c in cls.permission_classes] == [expected]
