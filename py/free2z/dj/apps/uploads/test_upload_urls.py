"""
Upload URL construction and the nginx auth subrequests, against real
Postgres.

The bug these cover: a URL the API itself handed out has to be usable
verbatim. Two ways that broke —

1. `Webp.get_url()` emitted the raw file name while every sibling URL
   builder percent-encoded it, so the same object had two different
   URLs and a reserved character produced an invalid one.
2. The auth views percent-decoded X-Original-URI *before* stripping the
   query/fragment, so an encoded `%23`/`%3F` inside a stored name became
   a real delimiter and the name was truncated — a 401 on a correct URL.

File storage is redirected to a tmp dir (default storage in settings is
GCS; only that external boundary is swapped, per repo test rules).
"""
from io import BytesIO
from datetime import timedelta
import uuid
from urllib.parse import quote, urlparse

import pytest
from PIL import Image

from django.core.files.base import ContentFile
from django.urls import reverse
from django.utils import timezone

from dj.apps.g12f.models import Subscription, zPage
from dj.apps.uploads.models import GenericFile, Webp


@pytest.fixture(autouse=True)
def _local_media(settings, tmp_path):
    settings.STORAGES = {
        **settings.STORAGES,
        "default": {
            "BACKEND": "django.core.files.storage.FileSystemStorage",
        },
    }
    settings.MEDIA_ROOT = str(tmp_path)


def _png_bytes():
    image = Image.new("RGB", (8, 8), (10, 120, 200))
    out = BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


def _make_file(owner, name="pic.png", access="public", mime="image/png"):
    return GenericFile.objects.create(
        owner=owner,
        file=ContentFile(_png_bytes(), name=name),
        mime_type=mime,
        access=access,
    )


def _hls_url(gfile, output="master.m3u8"):
    stored_name = gfile.file.name
    assert stored_name.endswith(".mp4")
    username, filename = stored_name[:-4].split("/", 1)
    return (
        f"/uploadz/public/hls/{quote(username, safe='')}/"
        f"{quote(filename, safe='')}/{output}"
    )


def _general_url(gfile):
    """The general `/uploadz/...` route the `uploads_auth` view gates."""
    return f"/uploadz/{quote(gfile.file.name)}"


@pytest.mark.django_db(transaction=True)
def test_urls_are_percent_encoded_and_parse_back_to_the_stored_name(
        creator_factory):
    """
    The repro from: a non-ASCII username directory. The URL must be
    percent-encoded, and parsing it has to give back exactly the path we
    built — nothing lost at the multibyte sequences.
    """
    creator = creator_factory(username="cΔrovΣr0")
    gfile = _make_file(creator, access="private")

    url = gfile.get_url()

    assert url == f"/uploadz/{quote(gfile.file.name)}"
    assert "%CE%94" in url and "%CE%A3" in url
    parsed = urlparse(f"https://free2z.cash{url}")
    assert parsed.path == url
    assert parsed.query == "" and parsed.fragment == ""


@pytest.mark.django_db(transaction=True)
def test_webp_thumbnail_url_is_encoded_like_every_other_url(creator_factory):
    creator = creator_factory(username="cΔrovΣr0")
    parent = _make_file(creator)
    webp = Webp.objects.create(
        parent=parent,
        file=ContentFile(_png_bytes(), name="pic.webp"),
    )

    assert webp.get_url() == f"/uploadz/public/{quote(webp.file.name)}"
    assert "%CE%94" in webp.get_url()
    # get_thumbnail() is what the API serializes, so it must agree.
    assert parent.get_thumbnail() == webp.get_url()


@pytest.mark.django_db(transaction=True)
def test_public_auth_accepts_the_encoded_url_the_api_handed_out(
        client, creator_factory):
    creator = creator_factory(username="cΔrovΣr0")
    gfile = _make_file(creator, access="public")

    response = client.get(
        reverse("uploads_auth_public"),
        HTTP_X_ORIGINAL_URI=gfile.get_url(),
    )

    assert response.status_code == 200


@pytest.mark.django_db(transaction=True)
def test_featured_image_public_url_tracks_page_visibility(
        client, creator_factory):
    creator = creator_factory(username="draft-image-owner")
    subscriber = creator_factory(username="draft-image-fan")
    gfile = _make_file(creator, access="public")
    page = zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        title="Image visibility",
        content="Page body",
        featured_image=gfile,
        is_published=False,
    )
    public_auth_url = reverse("uploads_auth_public")
    original_uri = gfile.get_url()

    # Anonymous requests to the public URL are denied while the page is a
    # draft, while the authenticated creator can still preview it without
    # putting their response in a shared cache.
    client.logout()
    denied = client.get(
        public_auth_url, HTTP_X_ORIGINAL_URI=original_uri)
    assert denied.status_code == 401
    client.force_login(subscriber)
    other_creator_denied = client.get(
        public_auth_url, HTTP_X_ORIGINAL_URI=original_uri)
    assert other_creator_denied.status_code == 401
    client.force_login(creator)
    creator_preview = client.get(
        public_auth_url, HTTP_X_ORIGINAL_URI=original_uri)
    assert creator_preview.status_code == 200
    assert creator_preview["X-Upload-Cache-Control"] == "private, no-store"

    # Published subscriber-only pages still expose their featured image as a
    # public teaser, matching the public list serializer. The publication
    # predicate controls this media boundary; page-body subscription checks
    # remain in the zPage read and event paths.
    zPage.objects.filter(pk=page.pk).update(is_published=True)
    client.logout()
    published = client.get(
        public_auth_url, HTTP_X_ORIGINAL_URI=original_uri)
    assert published.status_code == 200
    assert published["X-Upload-Cache-Control"] == (
        "public, max-age=300, s-maxage=3600, proxy-revalidate"
    )

    zPage.objects.filter(pk=page.pk).update(is_subscriber_only=True)
    paid_teaser = client.get(
        public_auth_url, HTTP_X_ORIGINAL_URI=original_uri)
    assert paid_teaser.status_code == 200
    assert paid_teaser["X-Upload-Cache-Control"].startswith("public,")
    Subscription.objects.create(
        star=creator,
        fan=subscriber,
        expires=timezone.now() + timedelta(days=1),
    )
    client.force_login(subscriber)
    subscriber_preview = client.get(
        public_auth_url, HTTP_X_ORIGINAL_URI=original_uri)
    assert subscriber_preview.status_code == 200
    assert subscriber_preview["X-Upload-Cache-Control"].startswith("public,")


@pytest.mark.django_db(transaction=True)
def test_draft_featured_image_that_is_also_the_avatar_stays_public(
        client, creator_factory):
    """The API lets a draft's cover point at the creator's own avatar file.

    That file is already public on the profile; the draft gate must not
    break the avatar everywhere it renders, and hides nothing by trying.
    """
    creator = creator_factory(username="avatar-cover-owner")
    gfile = _make_file(creator, access="public")
    creator.avatar_image = gfile
    creator.save(update_fields=["avatar_image"])
    zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        title="Draft reusing the avatar",
        content="Page body",
        featured_image=gfile,
        is_published=False,
    )
    client.logout()
    response = client.get(
        reverse("uploads_auth_public"),
        HTTP_X_ORIGINAL_URI=gfile.get_url(),
    )
    assert response.status_code == 200
    assert response["X-Upload-Cache-Control"].startswith("public,")

    # A deactivated owner still loses it: the avatar exemption must not
    # outrank the  creator-state gate.
    type(creator).objects.filter(pk=creator.pk).update(is_active=False)
    response = client.get(
        reverse("uploads_auth_public"),
        HTTP_X_ORIGINAL_URI=gfile.get_url(),
    )
    assert response.status_code == 401


@pytest.mark.django_db(transaction=True)
def test_hls_permission_matrix_and_access_aware_cache_headers(
        client, creator_factory):
    owner = creator_factory(username="hls-owner")
    member = creator_factory(username="hls-member")
    nonmember = creator_factory(username="hls-nonmember")
    superuser = creator_factory(
        username="hls-admin", is_staff=True, is_superuser=True,
    )
    Subscription.objects.create(
        star=owner,
        fan=member,
        expires=timezone.now() + timedelta(days=1),
    )

    def status_for(user, url):
        if user is None:
            client.logout()
        else:
            client.force_login(user)
        return client.get(
            reverse("uploads_auth_public_hls"),
            HTTP_X_ORIGINAL_URI=url,
        )

    public = _make_file(owner, name="public-video.mp4", access="public",
                        mime="video/mp4")
    for user in (None, owner, member, nonmember, superuser):
        response = status_for(user, _hls_url(public))
        assert response.status_code == 200
        assert response["X-HLS-Cache-Control"] == (
            "public, max-age=60, must-revalidate"
        )
        assert "X-HLS-Vary" not in response

    private = _make_file(owner, name="private-video.mp4", access="private",
                         mime="video/mp4")
    expected = {None: 401, owner: 200, member: 401, nonmember: 401,
                superuser: 200}
    for user, expected_status in expected.items():
        response = status_for(user, _hls_url(private))
        assert response.status_code == expected_status
        if expected_status == 200:
            assert response["X-HLS-Cache-Control"] == "private, no-store"
            assert response["X-HLS-Vary"] == "Cookie"
        else:
            assert "X-HLS-Cache-Control" not in response

    members = _make_file(owner, name="members-video.mp4", access="members",
                         mime="video/mp4")
    expected = {None: 401, owner: 200, member: 200, nonmember: 401,
                superuser: 200}
    for user, expected_status in expected.items():
        response = status_for(user, _hls_url(members))
        assert response.status_code == expected_status
        if expected_status == 200:
            assert response["X-HLS-Cache-Control"] == "private, no-store"
            assert response["X-HLS-Vary"] == "Cookie"


@pytest.mark.django_db(transaction=True)
def test_hls_public_cache_transition_has_a_bounded_stale_window(
        client, creator_factory):
    """A public cache entry can outlive a restriction by at most 60 seconds."""
    owner = creator_factory(username="hls-transition-owner")
    gfile = _make_file(owner, name="transition-video.mp4", access="public",
                       mime="video/mp4")
    url = _hls_url(gfile)

    initial = client.get(
        reverse("uploads_auth_public_hls"),
        HTTP_X_ORIGINAL_URI=url,
    )
    assert initial.status_code == 200
    assert initial["X-HLS-Cache-Control"] == (
        "public, max-age=60, must-revalidate"
    )

    gfile.access = "members"
    gfile.save(update_fields=["access"])

    client.logout()
    revoked = client.get(
        reverse("uploads_auth_public_hls"),
        HTTP_X_ORIGINAL_URI=url,
    )
    assert revoked.status_code == 401

    client.force_login(owner)
    owner_response = client.get(
        reverse("uploads_auth_public_hls"),
        HTTP_X_ORIGINAL_URI=url,
    )
    assert owner_response.status_code == 200
    assert owner_response["X-HLS-Cache-Control"] == "private, no-store"
    assert owner_response["X-HLS-Vary"] == "Cookie"


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("output", [
    "master.m3u8",
    "index.m3u8",
    "index-v1-a1.m3u8",
    "iframes-f2-v1-a1.m3u8",
    "seg-1-v1-a1.ts",
    "init-v1-a1.mp4",
    "seg-1-v1-a1.m4s",
])
def test_every_hls_output_authorizes_the_same_parent(client, creator_factory,
                                                     output):
    owner = creator_factory(username="hls-output-owner")
    gfile = _make_file(owner, name="same-video.mp4", access="public",
                       mime="video/mp4")

    response = client.get(
        reverse("uploads_auth_public_hls"),
        HTTP_X_ORIGINAL_URI=_hls_url(gfile, output),
    )

    assert response.status_code == 200
    assert response["X-HLS-Username"] == quote(owner.username, safe="")
    assert response["X-HLS-Filename"] == "same-video"


@pytest.mark.django_db(transaction=True)
def test_hls_authorizes_legacy_literal_percent_filename(
        client, creator_factory):
    owner = creator_factory(username="legacy-hls-owner")
    GenericFile.objects.create(
        owner=owner,
        file="legacy-hls-owner/100%.mp4",
        mime_type="video/mp4",
        access="public",
    )

    response = client.get(
        reverse("uploads_auth_public_hls"),
        HTTP_X_ORIGINAL_URI=(
            "/uploadz/public/hls/legacy-hls-owner/100%25/master.m3u8"
        ),
    )

    assert response.status_code == 200
    assert response["X-HLS-Filename"] == "100%25"


@pytest.mark.django_db(transaction=True)
def test_hls_authorizes_legacy_percent_hex_filename(
        client, creator_factory):
    owner = creator_factory(username="legacy-hls-owner")
    GenericFile.objects.create(
        owner=owner,
        file="legacy-hls-owner/discount%25.mp4",
        mime_type="video/mp4",
        access="public",
    )

    response = client.get(
        reverse("uploads_auth_public_hls"),
        HTTP_X_ORIGINAL_URI=(
            "/uploadz/public/hls/legacy-hls-owner/discount%2525/"
            "master.m3u8"
        ),
    )

    assert response.status_code == 200
    assert response["X-HLS-Filename"] == "discount%2525"


@pytest.mark.django_db(transaction=True)
def test_hls_query_and_fragment_do_not_change_parent_identity(
        client, creator_factory):
    owner = creator_factory(username="hls-query-owner")
    gfile = _make_file(owner, name="query-video.mp4", access="public",
                       mime="video/mp4")
    url = _hls_url(gfile, "index-v1-a1.m3u8")

    response = client.get(
        reverse("uploads_auth_public_hls"),
        HTTP_X_ORIGINAL_URI=f"{url}?cache=other%2Fobject#ignored",
    )

    assert response.status_code == 200


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("uri", [
    "/uploadz/hls/hls-owner/video/master.m3u8",
    "/uploadz/public/hls/hls-owner/video",
    "/uploadz/public/hls/hls-owner/video/master.m3u8/extra",
    "/uploadz/public/hls//video/master.m3u8",
    "/uploadz/public/hls/hls-owner//master.m3u8",
    "/uploadz/public/hls/hls-owner/video/",
    "/uploadz/public/hls/hls-owner%2Fother/video/master.m3u8",
    "/uploadz/public/hls/hls-owner%252Fother/video/master.m3u8",
    "/uploadz/public/hls/hls-owner/video%2Fother/master.m3u8",
    "/uploadz/public/hls/hls-owner%5Cother/video/master.m3u8",
    "/uploadz/public/hls/hls-owner/video%5Cother/master.m3u8",
    "/uploadz/public/hls/hls-owner/video/master%5C.m3u8",
    "/uploadz/public/hls/./video/master.m3u8",
    "/uploadz/public/hls/%2E%2E/video/master.m3u8",
    "/uploadz/public/hls/hls-owner/../master.m3u8",
    "/uploadz/public/hls/hls-owner/video/%",
    "/uploadz/public/hls/hls-owner/video/%GG.m3u8",
    "/uploadz/public/hls/hls-owner/video/master.m3u8%2Fextra",
    "/uploadz/public/hls/hls-owner/video/video.m3u8",
    "/uploadz/public/hls/hls-owner/video/master.mp4",
    "/uploadz/public/hls/hls-owner/video/seg-one-v1-a1.ts",
])
def test_hls_rejects_malformed_or_ambiguous_uri_even_for_superuser(
        client, creator_factory, uri):
    superuser = creator_factory(
        username="hls-admin", is_staff=True, is_superuser=True,
    )
    client.force_login(superuser)

    response = client.get(
        reverse("uploads_auth_public_hls"),
        HTTP_X_ORIGINAL_URI=uri,
    )

    assert response.status_code == 401


@pytest.mark.django_db(transaction=True)
def test_hls_superuser_cannot_authorize_nonexistent_or_ambiguous_parent(
        client, creator_factory):
    superuser = creator_factory(
        username="hls-admin", is_staff=True, is_superuser=True,
    )
    client.force_login(superuser)

    nonexistent = client.get(
        reverse("uploads_auth_public_hls"),
        HTTP_X_ORIGINAL_URI=(
            "/uploadz/public/hls/hls-owner/missing-video/master.m3u8"
        ),
    )
    assert nonexistent.status_code == 401

    owner = creator_factory(username="hls-ambiguous-owner")
    # Only a legacy row flagged by migration 0014 can share a name.
    for legacy in (False, True):
        GenericFile.objects.create(
            owner=owner,
            file="hls-ambiguous-owner/duplicate-video.mp4",
            mime_type="video/mp4",
            access="public",
            legacy_shared_file=legacy,
        )
    ambiguous = client.get(
        reverse("uploads_auth_public_hls"),
        HTTP_X_ORIGINAL_URI=(
            "/uploadz/public/hls/hls-ambiguous-owner/duplicate-video/"
            "master.m3u8"
        ),
    )
    assert ambiguous.status_code == 401


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("output", [
    "master.m3u8",
    "index-v1-a1.m3u8",
    "seg-1-v1-a1.ts",
])
def test_public_hls_auth_maps_every_output_to_the_public_mp4(
        client, creator_factory, output):
    """
    Every nginx-vod output is authorized by the same source row.

    Carried over from  for its distinctive fixture: reserved delimiters
    (`#`, `?`, space) living inside the *stored* source filename. The auth
    view must decode only the two source components and ignore the generated
    output name.

     also parametrized nested outputs (`variant-1/index.m3u8`). Those are
    no longer reachable: the HLS location now anchors a single output segment
    (`(?<hls_output>[^/]+)$`) and a containment `location ~ ^/uploadz/public/hls/`
    returns 404 for any extra-segment path, so nginx never forwards them to the
    auth view at all. `test_hls_rejects_malformed_or_ambiguous_uri_even_for_
    superuser` pins that 401 at the Django layer.
    """
    creator = creator_factory(username="cΔrovΣr0")
    gfile = _make_file(
        creator, name="clip.mp4", access="public", mime="video/mp4",
    )
    gfile.file.name = f"{creator.username}/clip#1 ?x.mp4"
    gfile.save(update_fields=["file"])

    response = client.get(
        reverse("uploads_auth_public_hls"),
        HTTP_X_ORIGINAL_URI=(
            f"/uploadz/public/hls/{quote(creator.username, safe='')}/"
            f"{quote('clip#1 ?x', safe='')}/{output}"
        ),
    )

    assert response.status_code == 200
    assert response["X-HLS-Username"] == quote(creator.username, safe="")
    assert response["X-HLS-Filename"] == quote("clip#1 ?x", safe="")


@pytest.mark.django_db(transaction=True)
def test_public_auth_rejects_private_rows_even_for_superusers(
        client, creator_factory):
    """
    Carried over from. The `uploads_auth_public` half is unchanged: the
    public byte path never serves a private row, superuser or not.

    The HLS half deliberately changed here.  authorized `/uploadz/public/
    hls/` on `access == "public"` alone, which locked an owner out of their own
    private video. This PR authorizes HLS against the same matrix as every
    other upload (owner / member / superuser) and marks the response
    `private, no-store` so no shared cache may keep it — see
    `test_hls_permission_matrix_and_access_aware_cache_headers`.
    """
    owner = creator_factory(username="private-owner")
    admin = creator_factory(
        username="upload-admin", is_staff=True, is_superuser=True,
    )
    gfile = _make_file(
        owner, name="clip.mp4", access="private", mime="video/mp4",
    )

    client.force_login(admin)

    assert client.get(
        reverse("uploads_auth_public"),
        HTTP_X_ORIGINAL_URI=f"/uploadz/public/{quote(gfile.file.name)}",
    ).status_code == 401

    hls = client.get(
        reverse("uploads_auth_public_hls"),
        HTTP_X_ORIGINAL_URI=_hls_url(gfile),
    )
    assert hls.status_code == 200
    assert hls["X-HLS-Cache-Control"] == "private, no-store"
    assert hls["X-HLS-Vary"] == "Cookie"

    # The row stays unreachable for everyone without a claim on it.
    client.logout()
    assert client.get(
        reverse("uploads_auth_public_hls"),
        HTTP_X_ORIGINAL_URI=_hls_url(gfile),
    ).status_code == 401


@pytest.mark.django_db(transaction=True)
def test_auth_strips_the_query_string_without_truncating_the_name(
        client, creator_factory):
    """
    `?` and `#` are delimiters only when they are *not* encoded. A cache
    buster must be stripped; an encoded one inside the name must not be.
    """
    creator = creator_factory(username="kevin")
    gfile = _make_file(creator, access="public")
    # get_upload_path slugifies new uploads, so plant the reserved
    # characters directly on the stored name — legacy rows and the
    # non-slugified username segment can both contain them.
    gfile.file.name = "kevin/a#1 b?c.png"
    gfile.save(update_fields=["file"])

    encoded = gfile.get_url()
    assert encoded == "/uploadz/public/kevin/a%231%20b%3Fc.png"

    # The encoded name survives...
    assert client.get(
        reverse("uploads_auth_public"),
        HTTP_X_ORIGINAL_URI=encoded,
    ).status_code == 200
    #...while a real query string or fragment is still stripped.
    assert client.get(
        reverse("uploads_auth_public"),
        HTTP_X_ORIGINAL_URI=f"{encoded}?v=2",
    ).status_code == 200
    assert client.get(
        reverse("uploads_auth_public"),
        HTTP_X_ORIGINAL_URI=f"{encoded}#frag",
    ).status_code == 200


@pytest.mark.django_db(transaction=True)
def test_auth_does_not_explode_without_the_nginx_header(client):
    response = client.get(reverse("uploads_auth_public"))
    assert response.status_code == 401


@pytest.mark.django_db(transaction=True)
def test_public_auth_denies_rather_than_500s_on_a_duplicate_stored_name(
        client, creator_factory):
    """
    : `GenericFile.file` had no uniqueness constraint, so two rows
    ended up sharing a stored name.  added one, but it exempts the
    pre-existing pairs (`legacy_shared_file`), so this still happens. `_get_generic_file`'s `.get(file=name)` then
    raised `MultipleObjectsReturned` -- uncaught, all the way out to
    nginx's `auth_request` subrequest, which turns *any* non-200/401/403
    upstream status into a 500 it serves to every client. One production
    object (`XOZOKDIP/IMG_1628.JPG`) 500d on every request for weeks.

    An ambiguous lookup can't be authorized either way, so it must
    collapse to the same 401 as a missing row -- never raise past the
    view into nginx's hands. The negative control: reverting the
    `MultipleObjectsReturned` catch in `_get_generic_file` reproduces the
    original 500 here (`GenericFile.MultipleObjectsReturned` propagating
    out of the view as an unhandled exception).
    """
    first_owner = creator_factory(username="dup-owner-one")
    second_owner = creator_factory(username="dup-owner-two")
    dup_name = "shared-name-collision/IMG_0001.JPG"

    first = _make_file(first_owner, access="public")
    first.file.name = dup_name
    first.save(update_fields=["file"])

    # Only a legacy row flagged by migration 0014 can share a name.
    second = _make_file(second_owner, access="public")
    GenericFile.objects.filter(pk=second.pk).update(
        file=dup_name, legacy_shared_file=True)

    assert (
        GenericFile.objects.filter(file=dup_name).count() == 2
    ), "test setup must actually produce the duplicate the bug needs"

    response = client.get(
        reverse("uploads_auth_public"),
        HTTP_X_ORIGINAL_URI=f"/uploadz/public/{quote(dup_name)}",
    )
    assert response.status_code == 401

    # The general `/uploadz/...` route shares `_get_generic_file` too.
    response = client.get(
        reverse("uploads_auth"),
        HTTP_X_ORIGINAL_URI=f"/uploadz/{quote(dup_name)}",
    )
    assert response.status_code == 401


@pytest.mark.django_db(transaction=True)
def test_ambiguous_generic_file_never_falls_through_to_a_webp_match(
        client, creator_factory):
    """
     follow-up, from codex's adversarial review of this PR: folding
    `MultipleObjectsReturned` into the same `except` as `DoesNotExist`
    would make `_get_generic_file` treat "ambiguous" as "keep looking in
    the next table" -- so two PRIVATE `GenericFile` rows sharing a name
    could be masked by an unrelated PUBLIC `Webp` stored under that exact
    same name, and the public route would authorize it. Ambiguity on one
    table has to deny outright; it must never promote a match found in a
    different table.
    """
    private_owner_one = creator_factory(username="priv-owner-one")
    private_owner_two = creator_factory(username="priv-owner-two")
    public_owner = creator_factory(username="pub-owner")
    dup_name = "owner/shared.webp"

    first = _make_file(private_owner_one, access="private")
    first.file.name = dup_name
    first.save(update_fields=["file"])

    # Only a legacy row flagged by migration 0014 can share a name.
    second = _make_file(private_owner_two, access="private")
    GenericFile.objects.filter(pk=second.pk).update(
        file=dup_name, legacy_shared_file=True)

    assert GenericFile.objects.filter(file=dup_name).count() == 2

    # An unrelated PUBLIC parent whose Webp thumbnail happens to be
    # stored under the exact same name the two private rows collided on.
    # Forced onto that literal name the same way the duplicate above was
    # -- upload_to would otherwise place it somewhere else on disk, and
    # the point is the *stored name string* colliding, not the path.
    public_parent = _make_file(public_owner, access="public")
    webp = Webp.objects.create(
        parent=public_parent,
        file=ContentFile(_png_bytes(), name="placeholder.webp"),
    )
    webp.file.name = dup_name
    webp.save(update_fields=["file"])

    response = client.get(
        reverse("uploads_auth_public"),
        HTTP_X_ORIGINAL_URI=f"/uploadz/public/{quote(dup_name)}",
    )
    assert response.status_code == 401


@pytest.mark.django_db(transaction=True)
def test_upload_handle_returns_the_created_records_with_urls(
        client, creator_factory):
    """
    : the uploader needs the server-side URL to offer copy-link /
    open-in-new-tab immediately, so the endpoint must answer with the
    created records instead of a bare 201.
    """
    creator = creator_factory(username="kevin")
    client.force_login(creator)

    upload = ContentFile(_png_bytes(), name="pic.png")
    upload.content_type = "image/png"

    response = client.post(
        reverse("uploads_handle"),
        {
            "body": '[{"title": "pic", "name": "pic.png", '
                    '"access": "public"}]',
            "files": upload,
        },
    )

    assert response.status_code == 201
    payload = response.json()
    assert len(payload) == 1
    created = payload[0]

    stored = GenericFile.objects.get(id=created["id"])
    assert created["url"] == stored.get_url()
    assert created["url"].startswith("/uploadz/public/")
    assert created["mime_type"] == "image/png"


@pytest.mark.django_db(transaction=True)
def test_private_parent_webp_is_not_advertised_at_the_public_path(
        creator_factory):
    """
    The legacy Webp thumbnail was hard-coded to `/uploadz/public/`, so a
    private upload's thumbnail was handed out at a path whose auth view
    (uploads_auth_public) can only ever answer 401 — a broken thumbnail
    advertised at a path that claims to be public. Follow the parent's
    prefix like ImageVariant.get_url does.
    """
    creator = creator_factory(username="kevin")
    private_parent = _make_file(creator, access="private")
    webp = Webp.objects.create(
        parent=private_parent,
        file=ContentFile(_png_bytes(), name="private-pic.webp"),
    )

    url = webp.get_url()
    assert url.startswith("/uploadz/")
    assert not url.startswith("/uploadz/public/")
    assert private_parent.get_thumbnail() == url

    public_parent = _make_file(creator, access="public")
    public_webp = Webp.objects.create(
        parent=public_parent,
        file=ContentFile(_png_bytes(), name="public-pic.webp"),
    )
    assert public_webp.get_url().startswith("/uploadz/public/")


@pytest.mark.django_db(transaction=True)
def test_private_parent_webp_url_is_authorized_by_owner_only(
        client, creator_factory):
    """
    The private-prefixed thumbnail URL has to actually resolve: the
    generic auth view finds the Webp, walks to its parent, and applies
    the parent's access.
    """
    creator = creator_factory(username="kevin")
    parent = _make_file(creator, access="private")
    webp = Webp.objects.create(
        parent=parent,
        file=ContentFile(_png_bytes(), name="owner-only.webp"),
    )

    assert client.get(
        reverse("uploads_auth"),
        HTTP_X_ORIGINAL_URI=webp.get_url(),
    ).status_code == 401

    client.force_login(creator)
    assert client.get(
        reverse("uploads_auth"),
        HTTP_X_ORIGINAL_URI=webp.get_url(),
    ).status_code == 200


@pytest.mark.django_db(transaction=True)
def test_general_auth_carries_access_aware_cache_headers(
        client, creator_factory):
    """
    : the general `/uploadz/...` route used to carry an unconditional
    nginx `Cache-Control: public, max-age=86400`, so members-only blobs were
    publicly cacheable for a day and revocation did not take. The policy now
    travels from `uploads_auth` through `auth_request_set`, mirroring the
    HLS route: public tier stays publicly cacheable, everything else is
    `private, no-store`, and denials set nothing at all.

    `Vary` is NOT decided here. nginx stamps `Vary: Cookie` on this
    route unconditionally, on every tier, because it is a route-level Cloud
    CDN property rather than an auth result: the CDN caches a response only
    when `Vary` is absent or one of a fixed supported list, and `Cookie` is
    not on it, so that header is the only thing keeping this legacy alias out
    of the edge cache. Returning it per-tier dropped it from public answers
    and turned `max-age=86400` into a real 24h edge TTL. The policy on this
    route is `private` on every tier for the same reason -- the same path
    serves different bytes per requester -- so the two are layers, not
    duplicates.
    """
    owner = creator_factory(username="general-owner")
    member = creator_factory(username="general-member")
    nonmember = creator_factory(username="general-nonmember")
    superuser = creator_factory(
        username="general-admin", is_staff=True, is_superuser=True,
    )
    Subscription.objects.create(
        star=owner,
        fan=member,
        expires=timezone.now() + timedelta(days=1),
    )

    def auth_for(user, url):
        if user is None:
            client.logout()
        else:
            client.force_login(user)
        return client.get(reverse("uploads_auth"), HTTP_X_ORIGINAL_URI=url)

    members = _make_file(owner, name="members-pic.png", access="members")
    expected = {owner: 200, member: 200, nonmember: 401, superuser: 200}
    for user, expected_status in expected.items():
        response = auth_for(user, _general_url(members))
        assert response.status_code == expected_status
        if expected_status == 200:
            assert response["X-Upload-Cache-Control"] == "private, no-store"
        # The view never speaks for Vary on this route; nginx does, for every
        # tier. A per-tier Vary here is exactly the  regression.
        assert "X-Upload-Vary" not in response

    # A genuinely anonymous-public blob keeps today's 24h TTL, but as
    # `private`: this legacy alias serves public, members and
    # owner-only bytes on the same path depending on who asks, so no shared
    # cache may store any of it. `Vary: Cookie` is the second layer.
    public = _make_file(owner, name="public-pic.png", access="public")
    for user in (None, owner, member, nonmember, superuser):
        response = auth_for(user, _general_url(public))
        assert response.status_code == 200
        assert response["X-Upload-Cache-Control"] == "private, max-age=86400"
        assert "X-Upload-Vary" not in response

    # Denied requests must emit NO cache header at all: an empty
    # auth_request_set value makes nginx add nothing, so a 401 can never
    # inherit a cacheable policy.
    denied = auth_for(None, _general_url(members))
    assert denied.status_code == 401
    assert "X-Upload-Cache-Control" not in denied
    assert "X-Upload-Vary" not in denied


@pytest.mark.django_db(transaction=True)
def test_deactivated_owner_members_blob_is_denied_without_cache_headers(
        client, creator_factory):
    """
     item 4 through the general gate: a still-unexpired Subscription
    does not keep a deactivated creator's members blob servable. The 401
     must also carry no cache header, or one pre-ban fetch pins the
    object in a shared cache past the takedown.
    """
    owner = creator_factory(username="banned-general-owner")
    member = creator_factory(username="banned-general-member")
    Subscription.objects.create(
        star=owner,
        fan=member,
        expires=timezone.now() + timedelta(days=1),
    )
    blob = _make_file(owner, name="banned-members.mp4", access="members",
                      mime="video/mp4")

    client.force_login(member)
    before = client.get(
        reverse("uploads_auth"), HTTP_X_ORIGINAL_URI=_general_url(blob),
    )
    assert before.status_code == 200
    assert before["X-Upload-Cache-Control"] == "private, no-store"

    owner.is_active = False
    owner.save(update_fields=["is_active"])

    after = client.get(
        reverse("uploads_auth"), HTTP_X_ORIGINAL_URI=_general_url(blob),
    )
    assert after.status_code == 401
    assert "X-Upload-Cache-Control" not in after
    assert "X-Upload-Vary" not in after


@pytest.mark.django_db(transaction=True)
def test_private_kyc_auth_splits_the_uid_before_decoding(
        client, creator_factory):
    """
    Same decode-before-split bug class as the public view, but this one
    guards KYC documents. `%2F` decoded first re-segments the path, so
    `<my-uid>%2F..%2F<their-uid>/doc.pdf` presents `<my-uid>` as the
    first segment and the ownership check waves it through.
    """
    from dj.apps.kyc.models import UserProfile

    owner = creator_factory(username="kevin")
    other = creator_factory(username="jonathan")
    mine = UserProfile(user=owner)
    mine.id_front.name = f"{mine.id}/id_front.png"
    mine.save()
    theirs = UserProfile(user=other)
    theirs.id_front.name = f"{theirs.id}/id_front.png"
    theirs.save()

    client.force_login(owner)

    # The honest case still works (the name is a recorded document).
    assert client.get(
        reverse("uploads_auth_private"),
        HTTP_X_ORIGINAL_URI=f"/uploadz/private/{mine.id}/id_front.png",
    ).status_code == 200

    # The encoded separator must not buy access to another profile.
    assert client.get(
        reverse("uploads_auth_private"),
        HTTP_X_ORIGINAL_URI=(
            f"/uploadz/private/{mine.id}%2F..%2F{theirs.id}/id_front.png"
        ),
    ).status_code == 401
