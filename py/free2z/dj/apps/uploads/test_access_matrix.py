"""
The full media-access matrix, driven through the real nginx `auth_request`
views.

    One canonical piece of media. Exactly one access level. Never a copy at
    a different level.

    `private` must be unreachable by anyone except the owner. `members` must
    be reachable only by a paid subscriber of that creator (and the owner).

This module proves — or disproves — that statement by *executing* it:

    {public, members, private}
      x {owner, paid subscriber, logged-in non-subscriber, anonymous,
         superuser}
      x {original, legacy Webp, every ImageVariant width, HLS playlist,
         HLS segment}

and then the whole thing again with a **deactivated owner**, because
`_public_access_ok` / `_members_access_ok` exist for exactly that case and
 measured the HLS path answering 200 for a deactivated owner's members
blob.

Why the views and not the model helpers
---------------------------------------
nginx asks the VIEWS. `_public_access_ok` / `_members_access_ok` are an
implementation detail of two of them, and three of the four views reach a
verdict without calling either one on some branch. A matrix built on the
helpers would assert something nginx never evaluates.

Which view answers which URL
----------------------------
That mapping is nginx's, not Django's — `/uploadz/**` is served by nginx and
only the subrequest reaches Django. `nginx_auth_view()` below reconstructs it,
and `test_nginx_route_selection_matches_the_committed_config` pins the
reconstruction against the committed `k8s/free2z/nginx.conf` so it cannot
drift silently. CI never runs nginx, so that seam is exactly where a wrong
belief survives a green gate; the residual assumptions are listed in that
test's docstring.
"""
import re
from datetime import timedelta
from io import BytesIO
from urllib.parse import quote

import pytest
from PIL import Image

from django.core.files.base import ContentFile
from django.urls import reverse
from django.utils import timezone

from dj.apps.g12f.models import Subscription
from dj.apps.uploads.models import (
    VARIANT_WIDTHS, GenericFile, ImageVariant, Webp,
)




@pytest.fixture(autouse=True)
def _local_media(settings, tmp_path):
    """Only the external storage boundary is swapped; the DB stays real."""
    settings.STORAGES = {
        **settings.STORAGES,
        "default": {
            "BACKEND": "django.core.files.storage.FileSystemStorage",
        },
    }
    settings.MEDIA_ROOT = str(tmp_path)


# --------------------------------------------------------------------------
# nginx route selection
# --------------------------------------------------------------------------

# `location ~ ^/uploadz/public/hls/(?<username>[^/]+)/(?<filename>[^/]+)/
#  (?<hls_output>[^/]+)$`
_HLS_EXACT = re.compile(r"^/uploadz/public/hls/[^/]+/[^/]+/[^/]+$")

#What nginx returns for an HLS-shaped path with the wrong number of
#segments: the containment `location ~ ^/uploadz/public/hls/` is a bare
#`return 404` with no `auth_request`, so Django is never consulted.
NGINX_CONTAINMENT_404 = 404


def nginx_auth_view(url):
    """
    The Django view name nginx's `auth_request` would hit for `url`, or
    `NGINX_CONTAINMENT_404` when nginx answers without asking Django.

    Order matters and mirrors the order of the `location ~` blocks in
    `k8s/free2z/nginx.conf`: for regular expressions nginx takes the FIRST
    match in configuration-file order, so `^/uploadz/public/hls/...$` must be
    tested before `^/uploadz/public/`, and both before `^/uploadz/`.
    """
    path = url.split("?")[0].split("#")[0]
    if path.startswith("/uploadz/private/") and len(path) > len(
            "/uploadz/private/"):
        return "uploads_auth_private"
    if _HLS_EXACT.match(path):
        return "uploads_auth_public_hls"
    if path.startswith("/uploadz/public/hls/"):
        return NGINX_CONTAINMENT_404
    if path.startswith("/uploadz/public/") and len(path) > len(
            "/uploadz/public/"):
        return "uploads_auth_public"
    if path.startswith("/uploadz/") and len(path) > len("/uploadz/"):
        return "uploads_auth"
    return NGINX_CONTAINMENT_404


# --------------------------------------------------------------------------
# fixtures
# --------------------------------------------------------------------------

def _png_bytes(size=(8, 8)):
    image = Image.new("RGB", size, (10, 120, 200))
    out = BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


def _image_asset(owner, access, stem="pic"):
    """
    One canonical image plus every derivative it can have: the legacy `Webp`
    thumbnail and the full `ImageVariant` ladder.

    The variants are written directly rather than through
    `generate_image_variants`: this module is auditing the SERVE path, and
    the task's decode/encode work is several seconds per asset that would buy
    the matrix nothing.
    """
    gfile = GenericFile.objects.create(
        owner=owner,
        file=ContentFile(_png_bytes(), name=f"{stem}.png"),
        mime_type="image/png",
        access=access,
    )
    Webp.objects.create(
        parent=gfile,
        file=ContentFile(_png_bytes(), name=f"{stem}.webp"),
    )
    for width in VARIANT_WIDTHS:
        ImageVariant.objects.create(
            parent=gfile,
            width=width,
            format="webp",
            file=ContentFile(_png_bytes(), name=f"{stem}-{width}.webp"),
        )
    return GenericFile.objects.prefetch_related("variants", "webp").get(
        pk=gfile.pk)


def _video_asset(owner, access, stem="clip", with_poster=True):
    """A video plus the poster still  derives from it.

    The poster is an `ImageVariant` whose parent is the video, so it is a
    real artifact with a real URL and belongs in this matrix exactly like
    an image's variants do. The bytes are irrelevant here -- the nginx auth
    views resolve a served name back to a row and answer on the PARENT's
    access, which is the property under test.
    """
    gfile = GenericFile.objects.create(
        owner=owner,
        file=ContentFile(b"not-really-mp4", name=f"{stem}.mp4"),
        mime_type="video/mp4",
        access=access,
    )
    if with_poster:
        ImageVariant.objects.create(
            parent=gfile,
            width=800,
            format="webp",
            file=ContentFile(b"not-really-webp", name=f"{stem}_poster.webp"),
        )
    return GenericFile.objects.prefetch_related("variants").get(pk=gfile.pk)


def _hls_url(gfile, output):
    """
    The URL nginx-vod publishes for a VOD output.

    Note the shape: it is `/uploadz/public/hls/...` for EVERY access level.
    `vod_base_url` in nginx.conf is a public literal, so unlike every other
    artifact the HLS URL does not move when the level changes — the level is
    enforced only by `uploads_auth_public_hls` resolving the parent MP4.
    """
    stored = gfile.file.name
    assert stored.endswith(".mp4")
    username, filename = stored[:-4].split("/", 1)
    return (
        f"/uploadz/public/hls/{quote(username, safe='')}/"
        f"{quote(filename, safe='')}/{output}"
    )


HLS_PLAYLISTS = ["master.m3u8", "index-v1-a1.m3u8"]
HLS_SEGMENTS = ["seg-1-v1-a1.ts", "init-v1-a1.mp4"]


def image_artifacts(gfile):
    """(label, canonical URL) for the image and every derivative of it."""
    artifacts = [("original", gfile.get_url()),
                 ("legacy-webp", gfile.webp.get_url())]
    for variant in sorted(gfile.variants.all(), key=lambda v: v.width):
        artifacts.append((f"variant-{variant.width}", variant.get_url()))
    return artifacts


def video_artifacts(gfile):
    artifacts = [("original", gfile.get_url())]
    for variant in sorted(gfile.variants.all(), key=lambda v: v.width):
        artifacts.append((f"poster-{variant.width}", variant.get_url()))
    for output in HLS_PLAYLISTS:
        artifacts.append((f"hls-playlist:{output}", _hls_url(gfile, output)))
    for output in HLS_SEGMENTS:
        artifacts.append((f"hls-segment:{output}", _hls_url(gfile, output)))
    return artifacts


@pytest.fixture
def viewers(creator_factory):
    """
    The four viewers the rule names, plus `superuser` — which the rule does
    NOT name but the code grants, so it is pinned here rather than left
    undiscovered.

    `owner` is created last so the subscription can point at it.
    """
    owner = creator_factory(username="matrix-owner")
    subscriber = creator_factory(username="matrix-subscriber")
    stranger = creator_factory(username="matrix-stranger")
    superuser = creator_factory(
        username="matrix-admin", is_staff=True, is_superuser=True)
    Subscription.objects.create(
        star=owner,
        fan=subscriber,
        expires=timezone.now() + timedelta(days=30),
    )
    # A subscription that has run out is NOT a paid subscriber. Kept in the
    # cast so `members` cannot pass by "there is a Subscription row".
    expired = creator_factory(username="matrix-expired")
    Subscription.objects.create(
        star=owner,
        fan=expired,
        expires=timezone.now() - timedelta(days=1),
    )
    return {
        "owner": owner,
        "subscriber": subscriber,
        "expired-subscriber": expired,
        "stranger": stranger,
        "anonymous": None,
        "superuser": superuser,
    }


VIEWER_ORDER = [
    "owner", "subscriber", "expired-subscriber", "stranger", "anonymous",
    "superuser",
]


def probe(client, user, url):
    """Ask the view nginx would ask, exactly the way nginx asks it."""
    view = nginx_auth_view(url)
    if view == NGINX_CONTAINMENT_404:
        return NGINX_CONTAINMENT_404
    if user is None:
        client.logout()
    else:
        client.force_login(user)
    # nginx sends `proxy_set_header X-Original-URI $request_uri;` — the RAW,
    # still-percent-encoded request URI including any query string — and
    # forwards the client's own request headers (Cookie among them) to the
    # subrequest. See test_nginx_route_selection_matches_the_committed_config.
    return client.get(reverse(view), HTTP_X_ORIGINAL_URI=url).status_code


def observe(client, viewers, artifacts):
    """{artifact-label: {viewer-name: status}} for one asset."""
    return {
        label: {
            name: probe(client, viewers[name], url)
            for name in VIEWER_ORDER
        }
        for label, url in artifacts
    }


def expect(artifacts, per_viewer):
    return {label: dict(per_viewer) for label, _ in artifacts}


# --------------------------------------------------------------------------
# the matrix — active owner
# --------------------------------------------------------------------------

#What the owner's rule requires, viewer by viewer, for an ACTIVE creator.
#`superuser` is not part of the rule; it records what the code does.
ACTIVE_EXPECTED = {
    "public": {
        "owner": 200, "subscriber": 200, "expired-subscriber": 200,
        "stranger": 200, "anonymous": 200, "superuser": 200,
    },
    "members": {
        "owner": 200, "subscriber": 200, "expired-subscriber": 401,
        "stranger": 401, "anonymous": 401, "superuser": 200,
    },
    "private": {
        "owner": 200, "subscriber": 401, "expired-subscriber": 401,
        "stranger": 401, "anonymous": 401, "superuser": 200,
    },
}


@pytest.mark.django_db
@pytest.mark.parametrize("access", ["public", "members", "private"])
def test_image_access_matrix(client, viewers, access):
    """Original + legacy Webp + every ImageVariant width, all five viewers."""
    asset = _image_asset(viewers["owner"], access)
    artifacts = image_artifacts(asset)

    # The fixture is load-bearing: a cell that asserts 401 against an asset
    # that was never built at that level passes for the wrong reason.
    assert asset.access == access
    assert [label for label, _ in artifacts] == [
        "original", "legacy-webp", *[f"variant-{w}" for w in VARIANT_WIDTHS]
    ]
    prefix = "/uploadz/public/" if access == "public" else "/uploadz/"
    for label, url in artifacts:
        assert url.startswith(prefix), (label, url)
        if access != "public":
            assert not url.startswith("/uploadz/public/"), (label, url)

    assert observe(client, viewers, artifacts) == expect(
        artifacts, ACTIVE_EXPECTED[access])


@pytest.mark.django_db
@pytest.mark.parametrize("access", ["public", "members", "private"])
def test_video_and_hls_access_matrix(client, viewers, access):
    """Original MP4 + HLS playlists + HLS segments, all five viewers."""
    asset = _video_asset(viewers["owner"], access)
    artifacts = video_artifacts(asset)

    assert asset.access == access
    # Every HLS URL is public-prefixed whatever the level (vod_base_url).
    for label, url in artifacts:
        if label.startswith("hls-"):
            assert url.startswith("/uploadz/public/hls/"), (label, url)
            assert nginx_auth_view(url) == "uploads_auth_public_hls"

    assert observe(client, viewers, artifacts) == expect(
        artifacts, ACTIVE_EXPECTED[access])


# --------------------------------------------------------------------------
# the matrix — deactivated owner
# --------------------------------------------------------------------------

#With `creator.is_active = False` nothing is servable to anybody but a
#superuser, and even the superuser only through the routes that HAVE a
#superuser branch. `uploads_auth_public` has none by design, so a
#deactivated creator's `public` blob is 401 on its canonical URL for
#everyone — the owner included, because Django's `ModelBackend.get_user()`
#refuses to resolve an inactive user's session and the request arrives
#anonymous.
DEACTIVATED_PUBLIC_TIER = {
    "owner": 401, "subscriber": 401, "expired-subscriber": 401,
    "stranger": 401, "anonymous": 401, "superuser": 401,
}
DEACTIVATED_GENERAL_TIER = {
    "owner": 401, "subscriber": 401, "expired-subscriber": 401,
    "stranger": 401, "anonymous": 401, "superuser": 200,
}


@pytest.mark.django_db
@pytest.mark.parametrize("access", ["public", "members", "private"])
def test_image_access_matrix_with_deactivated_owner(client, viewers, access):
    owner = viewers["owner"]
    asset = _image_asset(owner, access)
    artifacts = image_artifacts(asset)

    # Negative control for the deactivation dimension itself: while the owner
    # is active the matrix is the ordinary one. If deactivation stopped
    # taking effect, THIS is the assertion that would still pass and the one
    # below that would fail.
    assert observe(client, viewers, artifacts) == expect(
        artifacts, ACTIVE_EXPECTED[access])

    owner.is_active = False
    owner.save(update_fields=["is_active"])
    assert not GenericFile.objects.select_related("owner").get(
        pk=asset.pk).owner.is_active

    expected = (DEACTIVATED_PUBLIC_TIER if access == "public"
                else DEACTIVATED_GENERAL_TIER)
    assert observe(client, viewers, artifacts) == expect(artifacts, expected)


@pytest.mark.django_db
@pytest.mark.parametrize("access", ["public", "members", "private"])
def test_video_and_hls_access_matrix_with_deactivated_owner(
        client, viewers, access):
    owner = viewers["owner"]
    asset = _video_asset(owner, access)
    artifacts = video_artifacts(asset)

    assert observe(client, viewers, artifacts) == expect(
        artifacts, ACTIVE_EXPECTED[access])

    owner.is_active = False
    owner.save(update_fields=["is_active"])

    # The MP4 original follows the same rule as any other blob. HLS always
    # goes through `uploads_auth_public_hls`, which DOES have a superuser
    # branch, so it stays 200 for a superuser on every level — including
    # `public`, where the byte route is 401 for everyone.
    expected = {}
    for label, _ in artifacts:
        if label.startswith("hls-"):
            expected[label] = dict(DEACTIVATED_GENERAL_TIER)
        elif access == "public":
            expected[label] = dict(DEACTIVATED_PUBLIC_TIER)
        else:
            expected[label] = dict(DEACTIVATED_GENERAL_TIER)

    assert observe(client, viewers, artifacts) == expected


# --------------------------------------------------------------------------
# one level per asset: the OTHER prefix must never serve it
# --------------------------------------------------------------------------

@pytest.mark.django_db
@pytest.mark.parametrize("access", ["members", "private"])
def test_restricted_artifacts_are_401_on_the_public_prefix_for_everyone(
        client, viewers, access):
    """
    "Never a copy at a different level" has a serve-path corollary: the URL
    a restricted asset WOULD have had if it were public must not work.

    `/uploadz/public/<name>` is `uploads_auth_public`, which has no owner,
    member or superuser branch at all — so this is 401 for all six viewers,
    and it stays 401 for the owner. That asymmetry is the point: a restricted
    asset has exactly one working URL, the general one.
    """
    asset = _image_asset(viewers["owner"], access)
    for _label, url in image_artifacts(asset):
        assert url.startswith("/uploadz/")
        public_twin = url.replace("/uploadz/", "/uploadz/public/", 1)
        assert nginx_auth_view(public_twin) == "uploads_auth_public"
        for name in VIEWER_ORDER:
            assert probe(client, viewers[name], public_twin) == 401, (
                url, name)


@pytest.mark.django_db
def test_public_artifacts_on_the_legacy_general_alias_stay_public(
        client, viewers):
    """
    The converse: a `public` row keeps working on `/uploadz/<name>`, the
    alias it held before/after a level change. This is the route whose cache
    policy `uploads_auth` has to downgrade to `private`  precisely
    because the same path serves different bytes per requester.
    """
    asset = _image_asset(viewers["owner"], "public")
    for _label, url in image_artifacts(asset):
        alias = url.replace("/uploadz/public/", "/uploadz/", 1)
        assert nginx_auth_view(alias) == "uploads_auth"
        for name in VIEWER_ORDER:
            assert probe(client, viewers[name], alias) == 200, (alias, name)
        response = client.get(
            reverse("uploads_auth"), HTTP_X_ORIGINAL_URI=alias)
        assert response["X-Upload-Cache-Control"] == "private, max-age=86400"


# --------------------------------------------------------------------------
# level switching, both directions
# --------------------------------------------------------------------------

@pytest.mark.django_db
def test_level_switching_moves_every_derived_url_and_the_verdict_with_it(
        client, viewers):
    """
    `public -> members -> private -> public`, asserting after EVERY hop that

      * the original, the legacy `Webp` and every `ImageVariant` URL sit on
        the prefix the new level implies (`GenericFile._get_prefix()` is the
        single source, so a derivative that hard-coded a prefix shows up
        here), and
      * the authorization verdict at each of those URLs is the new level's
        row of the matrix.

    A URL check alone would not catch a derivative that moved but stayed
    authorized as its old level, and a verdict check alone would not catch
    one that stayed at the old URL.
    """
    owner = viewers["owner"]
    asset = _image_asset(owner, "public")
    observed_prefixes = {}

    for level in ["public", "members", "private", "public"]:
        asset.access = level
        asset.save(update_fields=["access"])
        asset = GenericFile.objects.prefetch_related(
            "variants", "webp").get(pk=asset.pk)

        artifacts = image_artifacts(asset)
        prefix = "/uploadz/public/" if level == "public" else "/uploadz/"
        for label, url in artifacts:
            assert url.startswith(prefix), (level, label, url)
            observed_prefixes.setdefault(level, set()).add(
                url[:len(prefix)])
        assert observe(client, viewers, artifacts) == expect(
            artifacts, ACTIVE_EXPECTED[level])

    assert observed_prefixes == {
        "public": {"/uploadz/public/"},
        "members": {"/uploadz/"},
        "private": {"/uploadz/"},
    }


@pytest.mark.django_db
def test_level_switching_moves_the_hls_verdict_but_not_the_hls_url(
        client, viewers):
    """
    HLS is the one artifact whose URL does NOT move: `vod_base_url` in
    nginx.conf is the literal `/uploadz/public/hls/...`. Only the verdict
    moves. Documented rather than fixed — the URL is generated by nginx, not
    by Django, so changing it is an nginx change and its own PR.
    """
    owner = viewers["owner"]
    asset = _video_asset(owner, "public")
    urls_seen = set()

    for level in ["public", "members", "private", "public"]:
        asset.access = level
        asset.save(update_fields=["access"])
        asset.refresh_from_db()
        artifacts = video_artifacts(asset)
        for label, url in artifacts:
            if label.startswith("hls-"):
                urls_seen.add(url)
        assert observe(client, viewers, artifacts) == expect(
            artifacts, ACTIVE_EXPECTED[level])

    # Four hops, still exactly one URL per HLS output.
    assert len(urls_seen) == len(HLS_PLAYLISTS) + len(HLS_SEGMENTS)


@pytest.mark.django_db
def test_switching_a_level_never_creates_a_second_row(client, viewers):
    """
    The principle, stated as an invariant: a level change edits ONE row and
    creates nothing.
    """
    owner = viewers["owner"]
    asset = _image_asset(owner, "public")
    before = (
        GenericFile.objects.count(),
        Webp.objects.count(),
        ImageVariant.objects.count(),
    )
    stored_name = asset.file.name

    client.force_login(owner)
    for level in ["members", "private", "public"]:
        response = client.patch(
            f"/api/myuploads/{asset.pk}/",
            data={"access": level},
            content_type="application/json",
        )
        assert response.status_code == 200, response.content
        assert response.json()["access"] == level

    asset.refresh_from_db()
    assert asset.access == "public"
    # Same row, same bytes, same stored name — only the level moved.
    assert asset.file.name == stored_name
    assert (
        GenericFile.objects.count(),
        Webp.objects.count(),
        ImageVariant.objects.count(),
    ) == before


# --------------------------------------------------------------------------
# nginx reconstruction
# --------------------------------------------------------------------------

def _location_body(conf, start):
    """
    The text of one `location` block, from `start` to the next block that
    opens at the same indent (four spaces inside `server { }`).

    Deliberately not `str.find`-with-a-bare-fallback: when the sentinel is
    absent, `find` returns -1 and `body[:-1]` silently truncates by one
    character instead of failing, so the last block in the file would be
    checked against almost-everything.
    """
    tail = conf[start:]
    end = tail.find("\n    location ", 1)
    return tail if end == -1 else tail[:end]


def _directives_of(block):
    """
    The ACTIVE directives in an nginx block: comments stripped, whitespace
    collapsed.

    This function exists because of a negative control that failed. The first
    version of the test asserted `"auth_request /uploadsauth;" in body`, and
    the control that comments the directive out — the single most likely way
    this gate ever gets disabled — left the test GREEN, because a commented
    line still contains the string. A substring search over config text is a
    test that passes without testing.
    """
    directives = []
    for line in block.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        directives.append(" ".join(line.split()))
    return directives


def _serving_server_block(conf):
    """The `default_server` block — the one that owns `/uploadz`."""
    starts = [m.start() for m in re.finditer(r"^server \{", conf, re.M)]
    assert starts, "no server blocks in nginx.conf"
    for index, start in enumerate(starts):
        end = starts[index + 1] if index + 1 < len(starts) else len(conf)
        block = conf[start:end]
        if "listen 8080 default_server;" in block:
            return block
    raise AssertionError("no default_server block in nginx.conf")


def _parse_locations(block):
    """
    Every `location` in one server block, as
    ``(modifier, pattern, body)`` in configuration-file order.

    Only 4-space-indented `location` lines are collected — that is the nesting
    depth of a location directly inside `server { }`, and it is where all 67
    of them live today. A location nested deeper is inside another location
    and cannot be selected independently.
    """
    locations = []
    pattern = re.compile(r"^    location(?:\s+(=|\^~|~\*|~))?\s+(\S+)\s*\{",
                         re.M)
    for match in pattern.finditer(block):
        locations.append((
            match.group(1) or "",
            match.group(2),
            _location_body(block, match.start()),
        ))
    return locations


def _pcre_to_python(pattern):
    """nginx uses PCRE named groups `(?<n>...)`; Python spells them `(?P<n>...)`."""
    return re.sub(r"\(\?<([A-Za-z_][A-Za-z0-9_]*)>", r"(?P<\1>", pattern)


def resolve_nginx_location(block, path):
    """
    Which `location` nginx selects for `path`, implementing the documented
    algorithm rather than assuming an ordering:

      1. an exact `=` match wins immediately;
      2. otherwise remember the LONGEST prefix match; if that one is `^~`,
         it wins and no regex is tried;
      3. otherwise try every regex in configuration-file order and take the
         FIRST that matches;
      4. otherwise fall back to the longest prefix match from step 2.

    Written out in full because of the adversarial review's finding 2: a test
    that only checks the relative order of five KNOWN locations cannot see a
    sixth. A new `location ^~ /uploadz/` or an earlier
    `location ~ ^/uploadz/.*\\.mp4$` without an `auth_request` would win
    selection and serve restricted bytes unauthenticated, while an
    order-only assertion stayed green.
    """
    best_prefix = None
    regexes = []
    for modifier, pattern, body in _parse_locations(block):
        if modifier == "=":
            if path == pattern:
                return (modifier, pattern, body)
        elif modifier in {"~", "~*"}:
            regexes.append((modifier, pattern, body))
        else:  # "" or "^~"
            if path.startswith(pattern):
                if best_prefix is None or len(pattern) > len(best_prefix[1]):
                    best_prefix = (modifier, pattern, body)

    if best_prefix is not None and best_prefix[0] == "^~":
        return best_prefix

    for modifier, pattern, body in regexes:
        flags = re.IGNORECASE if modifier == "~*" else 0
        if re.search(_pcre_to_python(pattern), path, flags):
            return (modifier, pattern, body)

    return best_prefix


def _auth_request_of(body):
    """The `auth_request` target of a location body, or None."""
    for directive in _directives_of(body):
        if directive.startswith("auth_request "):
            return directive[len("auth_request "):].rstrip(";")
    return None




@pytest.mark.django_db
@pytest.mark.parametrize("url,expected", [
    ("/uploadz/public/kevin/pic.png", "uploads_auth_public"),
    ("/uploadz/kevin/pic.png", "uploads_auth"),
    ("/uploadz/private/7/id.png", "uploads_auth_private"),
    ("/uploadz/public/hls/kevin/clip/master.m3u8", "uploads_auth_public_hls"),
    ("/uploadz/public/hls/kevin/clip/seg-1-v1-a1.ts",
     "uploads_auth_public_hls"),
    # Containment: nginx answers 404 itself, Django is never asked.
    ("/uploadz/public/hls/kevin/clip", NGINX_CONTAINMENT_404),
    ("/uploadz/public/hls/kevin/clip/master.m3u8/extra",
     NGINX_CONTAINMENT_404),
    ("/uploadz/public/hls/", NGINX_CONTAINMENT_404),
])
def test_nginx_auth_view_selection(url, expected):
    assert nginx_auth_view(url) == expected


# --------------------------------------------------------------------------
# variant_url()'s legacy-Webp fallback
# --------------------------------------------------------------------------

@pytest.mark.django_db
@pytest.mark.parametrize("access", ["public", "members", "private"])
def test_legacy_webp_fallback_gate_is_a_live_restriction_not_dead_code(
        client, viewers, access):
    """
    Record what `GenericFile.variant_url()` ACTUALLY does for a parent with a
    legacy `Webp` and no `ImageVariant`s — the shape every image uploaded
    before the ladder existed, and every image whose variant job failed.

    The gate (`if self.access == "public"`) is **a live restriction, not dead
    code and not a security bug**, and its stated reason is now obsolete:

      * live — this branch is the only source of `thumb`/`card`/`banner` for
        a no-variant image, and it is reached on every level;
      * not a bug in the leak direction — it fails CLOSED, returning None;
      * obsolete reason — the comment says the legacy Webp URL is "always
        public", which stopped being true when `Webp.get_url()` started
        following the parent's prefix. The URL it withholds is exactly the
        one `get_thumbnail()` hands out one method away, and `uploads_auth`
        authorizes it identically to the original (asserted below).

    So the observable effect is an INCONSISTENT payload, not a leak: a
    members/private image reports `thumbnail` but `thumb == card == banner
    == None`. Left alone deliberately — lifting the gate changes what the
    API returns and contradicts an assertion  still pins
    (`test_variant_url_never_falls_back_to_original`), which is a behaviour
    change owed its own reviewed PR, not a rider on an audit.
    """
    owner = viewers["owner"]
    gfile = GenericFile.objects.create(
        owner=owner,
        file=ContentFile(_png_bytes(), name="legacy-only.png"),
        mime_type="image/png",
        access=access,
    )
    webp = Webp.objects.create(
        parent=gfile,
        file=ContentFile(_png_bytes(), name="legacy-only.webp"),
    )
    gfile = GenericFile.objects.prefetch_related("variants", "webp").get(
        pk=gfile.pk)
    assert not gfile.variants.exists()

    if access == "public":
        assert gfile.variant_url(128) == webp.get_url()
        assert gfile.variant_url(1600) == webp.get_url()
    else:
        assert gfile.variant_url(128) is None
        assert gfile.variant_url(1600) is None

    #...while `get_thumbnail()` hands out that same URL on every level.
    assert gfile.get_thumbnail() == webp.get_url()

    # And the withheld URL is not withheld because it is unsafe: it carries
    # the parent's prefix and authorizes exactly like the parent's original.
    original_row = {
        name: probe(client, viewers[name], gfile.get_url())
        for name in VIEWER_ORDER
    }
    webp_row = {
        name: probe(client, viewers[name], webp.get_url())
        for name in VIEWER_ORDER
    }
    assert webp_row == original_row == ACTIVE_EXPECTED[access]


@pytest.mark.django_db
@pytest.mark.parametrize("access", ["members", "private"])
def test_serializer_reports_a_thumbnail_it_will_not_report_a_size_for(
        access, viewers):
    """The user-visible shape of the inconsistency above, through the API."""
    from dj.apps.uploads.serializers import FeaturedImageSerializer

    gfile = GenericFile.objects.create(
        owner=viewers["owner"],
        file=ContentFile(_png_bytes(), name="legacy-only.png"),
        mime_type="image/png",
        access=access,
    )
    Webp.objects.create(
        parent=gfile,
        file=ContentFile(_png_bytes(), name="legacy-only.webp"),
    )
    data = FeaturedImageSerializer(
        GenericFile.objects.prefetch_related("variants", "webp").get(
            pk=gfile.pk)
    ).data

    assert data["thumbnail"] == gfile.webp.get_url()
    assert data["thumb"] is None
    assert data["card"] is None
    assert data["banner"] is None
    assert data["variants"] == []
