import os
from django import http
from django.urls import path, include, re_path, register_converter
from django.conf.urls.static import static
from django.contrib import admin
from django.conf import settings
from django.http import HttpResponseNotFound, HttpResponseRedirect

from dj.free2z.routers import Free2zRouter
from drf_spectacular.views import SpectacularRedocView, SpectacularSwaggerView

from dj.free2z.schema_view import SchemaView

from dj.apps.g12f import views
from dj.apps.g12f.views import crawler
from dj.apps.g12f.views import translate as translate_views
from dj.apps.g12f.views import translate_batch as translate_batch_views
# Imported by full module path, not `from...views import language_catalog`:
# `views/__init__.py` does `from.zpage import *`, which re-exports whatever
# names zpage.py imported -- including `languages` (the registry module). A
# package attribute shadowing a submodule is how that trap reads at runtime.
from dj.apps.g12f.views.language_catalog import LanguageCatalogView
from dj.apps.g12f.views.scheme import KnoxTokenScheme  # noqa
from dj.apps.health import views as healthviews
from dj.apps.uploads import views as uploadsviews
from dj.apps.uploads import limits as uploadslimits
from dj.apps.oidc import views as oidc_views
from dj.apps.openai import views as oaiviews
from dj.apps.storytime import views as storyviews
from dj.apps.comments.reports import ContentReportCreate

from rest_framework.settings import api_settings
from dj_rest_auth.views import LogoutView as RestAuthLogoutView
from dj_rest_auth.views import (
    PasswordChangeView as RestAuthPasswordChangeView,
)
from knox.views import LogoutAllView as KnoxLogoutAllView
from knox.views import LoginView as KnoxLoginView
from knox.views import LogoutView as KnoxLogoutView

from dj.apps.ktauth.authentication import (
    AccountEpochTokenAuthentication,
)
from dj.apps.identity.views import RecentAuthenticationView
from dj.apps.g12f.views.account_deletion import (
    AccountDeletionKeepView, AccountDeletionScheduleView, AccountDeletionView,
)
from dj.apps.identity.auth_context import (
    INHERIT,
    forget_all_tokens,
    forget_request_credentials,
    record_login,
)
from dj.apps.ktauth.credentials import (
    purge_unusable_tokens,
    stamp_issued_token,
)


class LogoutAllView(KnoxLogoutAllView):
    authentication_classes = api_settings.DEFAULT_AUTHENTICATION_CLASSES

    # Every token is deleted, so every token's AuthContext goes too.
    # The `user_logged_out` receiver only knows the credential the request
    # presented; the rest would be inert (nobody can present a deleted
    # token) but would sit in the table until they expire.
    def post(self, request, format=None):
        response = super().post(request, format=format)
        forget_all_tokens(request.user)
        return response


# knox's `/api/token/login/`, with the epoch stamp taken from the request that
# authorised it rather than from the clock.
#
# `AuthToken`'s `post_save` receiver stamps every token, but it necessarily
# reads the counter AFTER the row is inserted -- which is one statement too
# late for exactly the interleaving  is about: a caller starts this POST
# holding a credential valid at epoch N, the owner changes their password
# (N+1, sweep runs, the token does not exist yet), the view then inserts and
# the receiver reads N+1. The evicted caller walks away with a current token.
# Found by the codex adversarial review of this change; the two login views
# this repo owns already stamped from their own snapshot, and this is the
# third issuer -- knox's, which nothing here calls.
#
# `get_post_response_data` is knox's hook, called with the freshly created
# instance and before the response is built, so it needs no reimplementation of
# `post()` and cannot drift from knox's token-limit and TTL handling.
# `request.user` is what authentication loaded from the row that validated this
# caller's own credential, so an event committing after that read leaves the
# stamp behind the account and the token is refused the first time it is used.
class LoginView(KnoxLoginView):
    # `post()` is overridden ONLY to drop the caller's unusable rows first --
    # it delegates straight to knox, so the token-limit and TTL handling stays
    # knox's and cannot drift.
    #
    # Without this, the knox 4.2.0 -> 5.1.0 upgrade can lock a user out for up
    # to `TOKEN_TTL` (10 hours): 5.x cannot authenticate a token minted by
    # 4.2.0, but `TOKEN_LIMIT_PER_USER` counts rows that are merely UNEXPIRED,
    # so five dead rows earn a 403 here -- and neither logout route can clear
    # them, because both require a working token: up to `TOKEN_TTL` (10h).
    # Reachable by callers who DID authenticate (session cookie, or a valid
    # 5.x token) -- a dead legacy bearer token fails authentication before
    # `post()` runs, so this cannot and does not claim to rescue that case.
    #
    # NOT done as a data migration, deliberately: `migrate` runs before
    # `bazel-apply`, so emptying the table there destroys credentials that
    # are still valid on the 4.2.0 pods, for a 5.1.0 rollout that may fail or
    # be rolled back (which restores the image, not the schema) -- exactly
    # the destructive-migration hazard `bin/prod-healthcheck.sh` warns about.
    # See `ktauth.credentials.purge_unusable_tokens` for the full argument.
    def post(self, request, format=None):
        purge_unusable_tokens(request.user)
        return super().post(request, format=format)

    def get_post_response_data(self, request, token, instance):
        stamp_issued_token(instance, request.user.kt_account_epoch)
        # An exchange, not an authentication: the token carries the
        # AuthContext of the session or token that asked for it, stamped
        # with the same epoch, or none at all. A fresh `auth_time` here
        # would let any session, however old, reset it by minting a token.
        record_login(
            request, request.user,
            methods=INHERIT,
            token=instance,
            account_epoch=request.user.kt_account_epoch,
        )
        return super().get_post_response_data(request, token, instance)


# knox's logout, on the project's Knox authenticator rather than knox's own.
#
# Stock `knox.views.LogoutView` hard-codes
# `authentication_classes = (TokenAuthentication,)` -- knox's class, which does
# NOT carry the use-time account-epoch check. A per-view override of the
# global default is exactly what `dj/apps/test_authentication_inventory.py`
# exists to catch: it is how a credential the platform has revoked keeps one
# door open. The blast radius of this particular door is small -- the view
# deletes the token it was presented with -- which is why it is corrected here
# rather than treated as an incident.
#
# Only the token authenticator, NOT `DEFAULT_AUTHENTICATION_CLASSES`: the view's
# body is `request._auth.delete()`, and `request.auth` is None under
# SessionAuthentication, so admitting the session cookie here would turn a
# cookie-authenticated logout into a 500. (`LogoutAllView` above can take the
# full default list because it works from `request.user` instead.) It also keeps
# the published `security:` for this operation byte-identical.
#
# Routed above `include('knox.urls')` so this entry wins; the include's own
# `logout/` becomes unreachable, exactly as `logoutall/` already is.
# No docstring, deliberately: drf-spectacular publishes one as the operation
# description, and this reasoning is for maintainers, not for API clients.
class LogoutView(KnoxLogoutView):
    authentication_classes = [AccountEpochTokenAuthentication]

    # Forget the token's AuthContext  BEFORE knox deletes the row:
    # the digest is `AuthToken`'s primary key, and Django clears the primary
    # key of a deleted instance, so the `user_logged_out` receiver that knox
    # fires afterwards can no longer name the token.
    def post(self, request, format=None):
        forget_request_credentials(request)
        return super().post(request, format=format)


class CanonicalIntConverter:
    """Unsigned decimal integers without cache-key aliases such as ``00``."""

    # Group the alternation so OpenAPI generators preserve full-string
    # anchoring instead of emitting the weaker ``^0|[1-9][0-9]*$``.
    regex = r"(?:0|[1-9][0-9]*)"

    def to_python(self, value):
        return int(value)

    def to_url(self, value):
        value = str(value)
        if value == "0" or (value.isdigit() and not value.startswith("0")):
            return value
        raise ValueError("Sitemap page must be a canonical unsigned integer.")


register_converter(CanonicalIntConverter, "canonical_int")


router = Free2zRouter()
router.register(r'zpage', views.zPageView, 'zpage')
router.register(r'start', views.SignUpView, 'start')
router.register(r'creator', views.CreatorView, 'creator')
router.register(r'myuploads', uploadsviews.MyUploadsViewSet, "myuploads")


def e404(request):
    # context = {}
    #    return render(request,'g12f/404.html', context, status=404)
    raise http.Http404


urlpatterns = [
    # Dependency check for MONITORING, not for kubelet. It runs a SELECT 1;
    # a kubelet probe pointed here would fail on every replica at once the
    # moment Cloud SQL hiccups. The kubelet startupProbes use
    # /api/healthz, which is served by HealthCheckMiddleware and never
    # reaches this URLconf at all. See dj/apps/health/views.py.
    path('api/readyz', healthviews.readyz, name='readyz'),
    #the last per-commit queue smoke; read by the promotion gate.
    path('api/jobs/smoke', healthviews.jobs_smoke, name='jobs-smoke'),

    # YOUR PATTERNS
    # SchemaView, not drf-spectacular's own view: same response, but its
    # ~72 generator diagnostics per hit stay off stderr.
    path('api/schema/', SchemaView.as_view(), name='schema'),
    # Optional UI:
    path('api/schema/swagger-ui/',
         SpectacularSwaggerView.as_view(url_name='schema'), name='swagger-ui'),
    path('api/schema/redoc/',
         SpectacularRedocView.as_view(url_name='schema'), name='redoc'),
]

if not settings.DEBUG:
    urlpatterns = urlpatterns + [
        path('adminzzz/login/', lambda r: HttpResponseNotFound()),
    ]


urlpatterns = urlpatterns + [
    path('adminzzz/', admin.site.urls),
    # `api/efm/` intentionally absent: the EFM/FROST experiment is OFFLINE.
    # See the module docstring in dj/apps/efm/__init__.py before re-adding it.
    path('api/reports/', ContentReportCreate.as_view(), name='content-report'),
    path('api/comments/', include('dj.apps.comments.urls')),
    path('api/events/', include('dj.apps.events.urls')),
    path('api/g12f/', include('dj.apps.g12f.urls')),
    path('api/ai/', include('dj.apps.openai.urls')),
    path('api/twitter/', include('dj.apps.twitter.urls')),
    path('api/tuzis/', include('dj.apps.tuzis.urls')),
    path('api/stripe/', include('dj.apps.ztripe.urls')),
    path('api/economy/', include('dj.apps.economy.urls')),
    # The SDK contract root: spec error envelope on every non-2xx.
    path('api/sdk/v1/', include('dj.free2z.sdk_urls')),
    path('api/pricing/', include('dj.apps.pricing.urls')),
    path('api/zuuli/', include('dj.apps.zuuli.urls')),
    path('api/e2ee/', include('dj.apps.e2ee.urls')),
    path('api/dyte/', include('dj.apps.dyte.urls')),
    path('api/emails/', include('dj.apps.emails.urls')),
    path('api/kyc/', include('dj.apps.kyc.urls')),
    # Key-transparency handle authority (docs/free2z/messaging/KT.md in free2z/zuu). One
    # POST; the platform's entire Django surface for E2EE identity.
    path('api/kt/', include('dj.apps.ktauth.urls')),
    # Messaging handles: the caller's binding, the claim flow, and the
    # authority's public key (dj/apps/handles). The assertion ktauth signs is
    # read from this binding.
    path('api/e2ee/', include('dj.apps.handles.urls')),
    path('api/otp/', include('dj.apps.otp.urls')),
    path('feeds/', include('dj.apps.feeds.urls')),
    path('api/tagging/', include('dj.apps.tagging.urls')),
    path('api/exports/', include('dj.apps.exports.urls')),

    # uploadz/ is the actual bucket, these are the auth checks
    path('uploads/auth-private', uploadsviews.uploads_auth_private,
         name="uploads_auth_private"),
    path('uploads/auth', uploadsviews.uploads_auth, name="uploads_auth"),
    path('uploads/auth-public', uploadsviews.uploads_auth_public,
         name="uploads_auth_public"),
    path('uploads/auth-public-hls', uploadsviews.uploads_auth_public_hls,
         name="uploads_auth_public_hls"),
    path('uploads/handle', uploadsviews.uploads_handle, name="uploads_handle"),
    path('uploads/single-public', uploadsviews.single_public_upload_handle,
         name="uploads_single_public"),
    path("uploads/limit", uploadsviews.upload_limit, name="upload_limit"),

    #...and the same table, said out loud. `uploads/limit` above is nginx's
    # internal auth subrequest (nginx returns 404 for a direct caller, and its
    # `@deny_upload` replaces the refusal with a bodiless 403), so no client
    # can discover its own ceiling from it. This one is an ordinary API read.
    path("api/uploads/limits/", uploadslimits.UploadLimitView.as_view(),
         name="uploads_limits"),

    # The language catalog. Mounted at the API root, not under
    # `api/g12f/`, because it describes the platform rather than any one app:
    # the editor's picker, the reader's variant switcher and third-party
    # clients all want the same list, and none of them is zPage-specific.
    path("api/languages/", LanguageCatalogView.as_view(),
         name="language-catalog"),

    # For hacky redirect of root either creator or zpage
    path('api/get-type/<str:id>',
         views.GetTypeAPI.as_view(),
         name='get-type'),

    # These entries used to SHADOW `include('dj_rest_auth.urls')` below (it
    # is now spelled out route by route,, and no longer mounts the
    # stock reset or login views), and the shadow only worked if it matched
    # everything the stock pattern matched.
    # dj-rest-auth >= 3.0 switched from `path('user/')` to
    # `re_path(r'user/?$')`, so the trailing slash became OPTIONAL upstream. A
    # `path()` override matches the slash form ONLY, and the no-slash request
    # falls straight through to the stock view (APPEND_SLASH does not redirect,
    # because the no-slash URL now resolves). re_path with `/?$` here, mirroring
    # upstream, so both forms land on our view.
    #
    # maybe TODO later
    # https://dj-rest-auth.readthedocs.io/en/latest/api_endpoints.html
    re_path(r'^api/auth/password/reset/?$', e404),
    re_path(r'^api/auth/password/reset/confirm/?$', e404),

    # dj-rest-auth's stock LoginView has no throttle_classes at all, and the
    # global default (AuthenticatedUserRateThrottle) returns None for an
    # anonymous caller -- so password login was the one credential endpoint
    # here with no rate limit of any kind. CreatorLoginView is the same
    # view with the sign-in path's per-IP bucket attached.
    #
    # Same optional-trailing-slash trap as the block above: upstream mounts
    # this as `re_path(r'login/?$')`, so a `path()` override would shadow only
    # the slash form and /api/auth/login would fall straight through to the
    # UNTHROTTLED stock view. Mirror the regex.
    re_path(r'^api/auth/login/?$', views.CreatorLoginView.as_view(),
            name='rest_login'),

    # Stock UserDetailsView + UserDetailsSerializer full-saves every loaded
    # column; CreatorProfileUpdateSerializer's PROFILE_WRITE_FIELDS allowlist is
    # what keeps a PATCH from restoring stale moderation/auth state.
    re_path(r'^api/auth/user/?$', views.CustomUserDetailsView.as_view(),
            name='rest_user_details'),

    # Login with Zcash ("ZUULI Zcash Login v1")
    path('api/auth/recent/', RecentAuthenticationView.as_view(), name='recent_authentication'),
    # Self-service account deletion behind /account/delete (Apple 5.1.1(v),
    # Google Play). GET previews, POST requests it (30-day grace); see
    # g12f.account_deletion. A sign-in during the grace period answers 409
    # with a keep token, spent at.../keep/ ("Keep my account").
    path('api/auth/account-deletion/', AccountDeletionView.as_view(),
         name='account_deletion'),
    path('api/auth/account-deletion/schedule/', AccountDeletionScheduleView.as_view(),
         name='account_deletion_schedule'),
    path('api/auth/account-deletion/keep/', AccountDeletionKeepView.as_view(),
         name='account_deletion_keep'),
    path('api/auth/zcash/', include('dj.apps.zauth.urls')),

    # Multi-provider social login ("ZUULI Social Login v1")
    path('api/auth/social/', include('dj.apps.social.urls')),

    # The OIDC identity provider: consent step, token, revocation,
    # introspection, userinfo, JWKS, discovery, the account's grants and the
    # internal epoch endpoint. All DRF views, all in f2z.yaml.
    path('api/oauth/', include('dj.apps.oidc.urls')),
    # Discovery at the site root, where OpenID Connect Discovery 1.0 puts it
    # (`{issuer}/.well-known/openid-configuration`). In production nginx's
    # exact location for this path forwards it here; locally Django serves
    # it directly. Above the crawler catch-alls, which would otherwise treat
    # `.well-known` as a username.
    path('.well-known/openid-configuration', oidc_views.RootDiscoveryView.as_view(),
         name='oidc-discovery-root'),

    # dj-rest-auth's routes, spelled out instead of `include('dj_rest_auth.urls')`
    #. The include mounted upstream's own LoginView too; it was
    # shadowed by CreatorLoginView above, but "an earlier pattern happens to
    # win" is one reordering away from an UNTHROTTLED password endpoint, and
    # that view is the one that minted the inert `rest_framework.authtoken`
    # key (see `dj.apps.ktauth.epoch._revoke_bearer_credentials`). Same
    # regexes, names and views as upstream for the two that are served; the
    # password-reset pair is already answered by the `e404` entries above, so
    # it is simply not mounted.
    re_path(r'^api/auth/logout/?$', RestAuthLogoutView.as_view(),
            name='rest_logout'),
    re_path(r'^api/auth/password/change/?$',
            RestAuthPasswordChangeView.as_view(),
            name='rest_password_change'),
    path('api/token/logoutall/', LogoutAllView.as_view(), name="knox_logout"),
    # `include('knox.urls')` is GONE, and its three routes are spelled out here
    # on the subclasses above. Shadowing it was not enough: a route that is
    # merely unreachable-by-resolution is still IN the URLconf, and
    # `dj/apps/test_authentication_inventory.py` walks the URLconf -- correctly,
    # because "an earlier pattern happens to win" is one reordering away from
    # being false, and what it would expose is a view authenticating Knox
    # tokens without the account-epoch check.
    #
    # Same paths and same route names as the include registered, so `reverse()`
    # and the published spec are unchanged. The `logoutall/` entry above keeps
    # its historical `knox_logout` name; the one below is the include's own,
    # in the include's own order, so `reverse('knox_logout')` still resolves to
    # `/api/token/logout/` exactly as it did.
    path('api/token/login/', LoginView.as_view(), name='knox_login'),
    path('api/token/logout/', LogoutView.as_view(), name='knox_logout'),
    path(
        'api/token/logoutall/',
        LogoutAllView.as_view(),
        name='knox_logoutall',
    ),

    path('api/zpage/fund/', views.FundPageView.as_view(), name="fund"),
    path('api/zpage/<str:free2zaddr>/vote/',
         views.vote_page, name="vote_page"),

    # Paid AI translation ( Part 6). Registered here rather than as
    # `@action`s on `zPageView` because the purchase needs
    # `atomic_request = False` -- a per-view-class flag -- and putting it on
    # the whole zPage viewset would opt every zPage write out of request
    # atomicity. Neither pattern collides with the router's variant routes:
    # those match `variants/<language>/` with a language regex that excludes
    # `/`, so a path with a further segment cannot reach them.
    path('api/zpage/<str:free2zaddr>/variants/<str:language>/translate/quote/',
         translate_views.ZPageTranslationQuoteView.as_view(),
         name="zpage_translation_quote"),
    path('api/zpage/<str:free2zaddr>/variants/<str:language>/translate/',
         translate_views.ZPageTranslationView.as_view(),
         name="zpage_translation"),
    # Parallel + bulk translation and the job tray. `translations/
    # quote/` MUST stay above `include(router.urls)`: the viewset's deprecated
    # `translations/(?P<language>[^/.]+)/` action would otherwise read `quote`
    # as a language. Django resolves in order, so declared here it wins.
    path('api/zpage/<str:free2zaddr>/translations/quote/',
         translate_batch_views.ZPageTranslationBatchQuoteView.as_view(),
         name="zpage_translation_batch_quote"),
    path('api/zpage/<str:free2zaddr>/translations/',
         translate_batch_views.ZPageTranslationJobsView.as_view(),
         name="zpage_translation_jobs"),
    path('api/sitemap/', views.SitemapIndexView.as_view(), name="sitemap-index"),
    path(
        'api/sitemap/<slug:kind>/<canonical_int:page>/<slug:revision>/',
        views.SitemapChunkView.as_view(),
        name="sitemap-chunk",
    ),

    path('api/openai/prompt',
         oaiviews.PromptView.as_view(), name="oai_prompt"),
    path('api/openai/image', oaiviews.ImageView.as_view(), name="oai_dalle"),

    path('api/storytime/mystories/', storyviews.MyStories.as_view({
        'get': 'list',
        #    'post': 'create',
        #    'put': 'update',
        #    'patch': 'partial_update',
        #    'delete': 'destroy',
    }), name="storytime_mystories"),
    path('api/storytime/mystories/<str:slug>', storyviews.MyStories.as_view({
        'get': 'retrieve',
        'patch': 'partial_update',
    }), name="storytime_mystories_detail"),
    path('api/storytime/start', storyviews.StartStory.as_view(),
         name="storytime_start"),
    path('api/storytime/<str:slug>/text',
         storyviews.PromptView.as_view(), name="storytime_get_text"),
    path('api/storytime/<str:slug>/image',
         storyviews.ImageView.as_view(), name="storytime_get_text"),
    path('api/storytime/<str:creator>/<str:slug>',
         storyviews.StoryDetail.as_view(), name="storytime_detail"),

    path(
        'api/creator/<str:username__iexact>/',
        views.CreatorView.as_view({'get': 'retrieve'}),
        name='creator_dumbass'
    ),
    path('api/zpage-random', views.zpage.zpage_random, name="zpage_random"),
    path('api/', include(router.urls)),

    # should never get here - for test!!
    re_path(
        r'^uploadz/(?P<path>.+)$',
        lambda request, path: HttpResponseRedirect(
            f'https://test.free2give.xyz/uploadz/{path}')
    ),

    # ------------------------------------------------------------------
    # Prerender for social / preview crawlers. See
    # dj/apps/g12f/views/crawler.py for what these are and why.
    #
    # ORDER MATTERS, TWICE OVER:
    #
    #  * This block MUST stay at the very bottom of urlpatterns. The last two
    #    patterns match *any* one- and two-segment path, so anything above
    #    them (api/, adminzzz/, feeds/, uploads/, uploadz/) would be shadowed
    #    if they moved up.
    #  * Within the block, literal segments come before the greedy
    #    <str:username> ones, mirroring SvelteKit's own precedence: a literal
    #    route beats the [username] / [vanity] parameters.
    #
    # Django's resolver keeps trying later patterns after an include() prefix
    # matches but resolves nothing inside it, so `/api/<unmatched>` DOES reach
    # the greedy patterns below. crawler.RESERVED_FIRST_SEGMENTS is what keeps
    # them from resolving there at all, so an unmatched API URL stays an
    # honest 404 (or an APPEND_SLASH redirect) instead of 200 text/html with
    # an OG card. BOTH the two-segment and the three-segment `/{x}/zpage/{y}`
    # shapes need that lookahead -- only the two-segment one had it at first,
    # and `/api/zpage/skylar` served an HTML card to API clients in prod.
    path('ai/conversation/<uuid:uuid>', views.ai_social, name="ai_social"),
    path('find', views.find_social, name="find_social"),
    path('zpage/<str:slug>',
         views.zpage_social, name="zpage_social"),
    # Legacy Django-only profile route. The VIEW resolves a zPage vanity
    # first -- SvelteKit has no `creator/` route, so `/creator/x` is an
    # ordinary {username}/{vanity} page URL over there. See the view.
    path('creator/<str:username>',
         views.legacy_creator_social, name="creator_social"),
    path('converse/<uuid:uuid>', views.converse_social, name="comment_social"),
    # /article/<identifier> is the collision-safe escape used when a creator's
    # pretty URL belongs to a product or ingress namespace. Keep social
    # unfurlers on the same immutable-address URL that browsers can render.
    path(
        'article/<str:identifier>',
        views.article_social,
        name="article_social",
    ),
    path('live/<str:username>', views.live_social, name="live_social"),
    path('checkout/<str:ref>', views.checkout_social, name="checkout_social"),
    # Legacy /{username}/zpage/{slug}. SvelteKit 301s this to the canonical
    # shape below; old shared links must keep rendering a card. re_path for
    # the same lookahead reason as the canonical route: the middle `zpage/`
    # literal does NOT make the first segment a username, and `/api/zpage/x`
    # used to resolve here and hand API clients an HTML card.
    re_path(crawler.ZPAGE_LEGACY_ROUTE,
            views.zpage_social_new, name="zpage_social_new"),
    # Canonical live-stream links use the same pretty two-segment shape as a
    # zPage. Match the three literal stream types before the vanity catch-all
    # so social unfurlers receive the same URL and metadata as SvelteKit.
    re_path(
        crawler.PRETTY_LIVE_ROUTE,
        views.pretty_live_social,
        name="pretty_live_social",
    ),
    path('<str:username>',
         views.creator_social_root, name="creator_social_root"),
    # The canonical zPage URL  and every URL in the sitemap. Missing
    # from this URLconf until, which is why no zPage link shared to
    # Twitter/X, Facebook, Slack, Discord, WhatsApp or Telegram rendered a
    # preview card. re_path, not path(): the pattern carries a negative
    # lookahead for the reserved first segments (see
    # crawler.RESERVED_FIRST_SEGMENTS) so `/api/<unmatched>` is not merely
    # 404'd by the view but never *resolves* here at all.
    re_path(crawler.ZPAGE_VANITY_ROUTE,
            views.zpage_vanity_social, name="zpage_social_vanity"),
    path('', views.find_social, name="crawler_fallback"),
]


if settings.DEBUG:
    urlpatterns += static(
        'uploadz/',
        document_root=os.path.join(settings.BASE_DIR, "uploadz")
    )

    # Only wire up debug_toolbar when the app is actually installed.
    # settings.py only adds 'debug_toolbar' to INSTALLED_APPS when
    # ENABLE_DEBUG_TOOLBAR is set; importing debug_toolbar.urls otherwise
    # touches its models (added in 7.0) before the app is registered, which
    # raises "Model class... doesn't declare an explicit app_label".
    if os.getenv('ENABLE_DEBUG_TOOLBAR', False):
        import debug_toolbar
        urlpatterns += [
            path('__debug__/', include(debug_toolbar.urls)),
            #...
        ]
