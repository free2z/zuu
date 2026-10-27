"""
Embedded-media enumeration for zPages, against real Postgres.

`embedded_media()` is the only thing that tells the SSR tier a zPage
contains a video, so every rule it enforces is load-bearing for what the
crawler is told. The tests below are grouped by the mistake they prevent:

  * advertising a video that is NOT anonymously fetchable,
  * advertising a `::embed[...]` that the renderer never turns into a video
    (inside a code fence, or a non-video extension),
  * reporting a poster that does not exist,
  * losing the list on a translated page, where `content` is overlaid after
    field serialization.
"""
import uuid

import pytest

from django.core.files.base import ContentFile

from dj.apps.g12f.embedded_media import (
    MAX_EMBEDDED_MEDIA,
    embed_values,
    embedded_media,
    upload_name_for_embed,
)
from dj.apps.g12f.models import zPage
from dj.apps.g12f.serializers.zpage import zPageDetailSerializer
from dj.apps.uploads.models import GenericFile, ImageVariant


@pytest.fixture(autouse=True)
def _local_media(settings, tmp_path):
    settings.STORAGES = {
        **settings.STORAGES,
        "default": {
            "BACKEND": "django.core.files.storage.FileSystemStorage",
        },
    }
    settings.MEDIA_ROOT = str(tmp_path)


def _video(owner, access="public", stem="clip", with_poster=True):
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


def _page(creator, content, **kwargs):
    return zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        title=kwargs.pop("title", "A page with a video"),
        content=content,
        **kwargs,
    )


# ---------------------------------------------------------------------------
# directive parsing
# ---------------------------------------------------------------------------

def test_embed_values_matches_the_renderer_block_rule():
    content = "\n".join([
        "::embed[/uploadz/public/u/a.mp4]",
        "  ::embed[/uploadz/public/u/b.mp4]",       # <=3 spaces: still an embed
        "    ::embed[/uploadz/public/u/c.mp4]",     # 4 spaces: indented code
        "text ::embed[/uploadz/public/u/d.mp4]",    # not at a block start
        "::embed[/uploadz/public/u/e.mp4] trailing",
        "::embed[/uploadz/public/u/a.mp4]",          # duplicate
    ])
    assert embed_values(content) == [
        "/uploadz/public/u/a.mp4",
        "/uploadz/public/u/b.mp4",
    ]


def test_embed_values_finds_embeds_inside_lists_and_blockquotes():
    """
    `marked` runs the block-directive tokenizer RECURSIVELY, so these render
    real `<video>` elements. Verified against `processMarkdown` directly:

        list item  => <video>? true
        blockquote => <video>? true

    A parser anchored at the line start alone finds none of them, and the
    page keeps exactly the SEO failure  is about while looking fixed.
    """
    content = "\n".join([
        "- ::embed[/uploadz/public/u/list.mp4]",
        "",
        "> ::embed[/uploadz/public/u/quote.mp4]",
        "",
        "1. ::embed[/uploadz/public/u/ordered.mp4]",
        "",
        "> > ::embed[/uploadz/public/u/nested-quote.mp4]",
    ])
    assert embed_values(content) == [
        "/uploadz/public/u/list.mp4",
        "/uploadz/public/u/quote.mp4",
        "/uploadz/public/u/ordered.mp4",
        "/uploadz/public/u/nested-quote.mp4",
    ]


def test_embed_values_ignores_fenced_code_blocks():
    content = "\n".join([
        "```markdown",
        "::embed[/uploadz/public/u/in-a-fence.mp4]",
        "```",
        "::embed[/uploadz/public/u/real.mp4]",
    ])
    assert embed_values(content) == ["/uploadz/public/u/real.mp4"]


@pytest.mark.parametrize("value,expected", [
    ("/uploadz/public/bob/clip.mp4", "bob/clip.mp4"),
    ("/uploadz/bob/clip.mp4", "bob/clip.mp4"),
    ("/uploadz/public/b%C3%B6b/clip.mp4", "böb/clip.mp4"),
    ("https://free2z.cash/uploadz/public/bob/clip.mp4", "bob/clip.mp4"),
    ("https://www.free2z.com/uploadz/bob/clip.mp4", "bob/clip.mp4"),
    # Not ours, not an upload, or not addressable.
    ("https://evil.example/uploadz/public/bob/clip.mp4", None),
    ("//free2z.cash/uploadz/public/bob/clip.mp4", None),
    ("/media/bob/clip.mp4", None),
    ("javascript:alert(1)", None),
    ("/uploadz/public/", None),
])
def test_upload_name_for_embed(value, expected):
    assert upload_name_for_embed(value) == expected


# ---------------------------------------------------------------------------
# resolution
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_public_video_is_reported_with_its_poster(creator_factory):
    creator = creator_factory(username="bob")
    video = _video(creator)

    items = embedded_media(f"::embed[{video.get_url()}]", creator)

    assert len(items) == 1
    item = items[0]
    assert item["kind"] == "video"
    assert item["url"] == video.get_url()
    assert item["embed_url"] == video.get_url()
    assert item["is_public"] is True
    assert item["access"] == "public"
    assert item["poster"] == video.get_poster()
    assert item["poster"].startswith("/uploadz/public/")
    assert item["uploaded_at"]


@pytest.mark.django_db
@pytest.mark.parametrize("access", ["members", "private"])
def test_gated_video_is_reported_but_never_as_public(creator_factory, access):
    """
    The caller decides; this must never LIE about the level.

    A `members` video is still a video on the page (the reader may be
    entitled to it), so it is reported — but `is_public` is False and every
    URL is on the authenticated prefix, which is what stops a `contentUrl`
    being emitted for it.
    """
    creator = creator_factory(username="bob")
    video = _video(creator, access=access)

    items = embedded_media(f"::embed[{video.get_url()}]", creator)

    assert len(items) == 1
    assert items[0]["is_public"] is False
    assert items[0]["access"] == access
    assert not items[0]["url"].startswith("/uploadz/public/")
    assert not items[0]["poster"].startswith("/uploadz/public/")


@pytest.mark.django_db
def test_deactivated_owner_makes_a_public_video_not_public(creator_factory):
    """
    `access == "public"` stopped being sufficient in.

    `uploads_auth_public` answers 401 for a deactivated creator's blob, so
    a crawler told to fetch it would get a 401 — the exact "we advertised
    something unfetchable" failure  is about.
    """
    creator = creator_factory(username="bob")
    video = _video(creator)
    creator.is_active = False
    creator.save(update_fields=["is_active"])

    items = embedded_media(f"::embed[{video.get_url()}]", creator)

    assert len(items) == 1
    assert items[0]["access"] == "public"
    assert items[0]["is_public"] is False


@pytest.mark.django_db
@pytest.mark.parametrize("access", ["members", "private"])
def test_a_gated_upload_reports_no_descriptive_metadata(
        creator_factory, access):
    """
    The reader here may be ANYONE: this runs on an anonymous detail request.

    An upload's title and description have never been anonymously readable.
    A page embedding its own creator's members-only video must not become the
    place they are -- and nothing needs them, because only a public row ever
    becomes a `VideoObject`.
    """
    creator = creator_factory(username="bob")
    video = _video(creator, access=access, stem="gated")
    video.title = "Unreleased cut"
    video.description = "Do not share"
    video.save(update_fields=["title", "description"])

    items = embedded_media(f"::embed[{video.get_url()}]", creator)

    assert len(items) == 1
    assert items[0]["is_public"] is False
    assert items[0]["title"] == ""
    assert items[0]["description"] == ""


@pytest.mark.django_db
def test_video_without_a_poster_reports_null(creator_factory):
    creator = creator_factory(username="bob")
    video = _video(creator, with_poster=False)

    items = embedded_media(f"::embed[{video.get_url()}]", creator)

    assert len(items) == 1
    assert items[0]["poster"] is None


@pytest.mark.django_db
def test_unknown_and_non_video_embeds_are_omitted(creator_factory):
    creator = creator_factory(username="bob")
    image = GenericFile.objects.create(
        owner=creator,
        file=ContentFile(b"not-really-png", name="pic.png"),
        mime_type="image/png",
    )

    items = embedded_media("\n".join([
        f"::embed[{image.get_url()}]",
        "::embed[/uploadz/public/bob/never-uploaded.mp4]",
        "::embed[https://youtube.com/watch?v=x]",
    ]), creator)

    assert items == []


@pytest.mark.django_db
def test_document_order_is_preserved(creator_factory):
    creator = creator_factory(username="bob")
    first = _video(creator, stem="aaa")
    second = _video(creator, stem="bbb")

    # Written in the opposite order to their primary keys.
    items = embedded_media("\n".join([
        f"::embed[{second.get_url()}]",
        f"::embed[{first.get_url()}]",
    ]), creator)

    assert [item["url"] for item in items] == [
        second.get_url(), first.get_url()]


# ---------------------------------------------------------------------------
# the serializer
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_detail_serializer_reports_media(creator_factory):
    creator = creator_factory(username="bob")
    video = _video(creator)
    page = _page(creator, content=f"Intro\n\n::embed[{video.get_url()}]\n")

    data = zPageDetailSerializer(page).data

    assert [item["url"] for item in data["media"]] == [video.get_url()]
    assert data["media"][0]["poster"] == video.get_poster()


@pytest.mark.django_db
def test_detail_serializer_reports_no_media_for_a_plain_page(creator_factory):
    creator = creator_factory(username="bob")
    page = _page(creator, content="Just words.")

    assert zPageDetailSerializer(page).data["media"] == []


@pytest.mark.django_db
def test_media_describes_the_body_that_was_actually_rendered(creator_factory):
    """
    `content` is overlaid by LocalizedZPageSerializerMixin AFTER every
    declared field is serialized. A `media` list built from `obj.content`
    would therefore describe the SOURCE article on a translated response —
    the wrong video, or a video on a page that does not show one.

    Pinned by rendering a page whose stored `content` embeds nothing and
    whose serialized `content` is what the mixin produced: the two must
    agree, whichever body wins.
    """
    creator = creator_factory(username="bob")
    video = _video(creator)
    page = _page(creator, content=f"::embed[{video.get_url()}]")

    data = zPageDetailSerializer(page).data

    embedded_in_response = embed_values(data["content"])
    assert embedded_in_response == [video.get_url()]
    assert [item["embed_url"] for item in data["media"]] == embedded_in_response


def test_embed_values_survives_crlf():
    """`$` under re.MULTILINE matches after a `\\r`, so CRLF matched nothing."""
    assert embed_values(
        "Intro\r\n\r\n::embed[/uploadz/public/u/a.mp4]\r\n"
    ) == ["/uploadz/public/u/a.mp4"]
    assert embed_values(
        "```\r\n::embed[/uploadz/public/u/code.mp4]\r\n```\r\n"
        "::embed[/uploadz/public/u/real.mp4]\r\n"
    ) == ["/uploadz/public/u/real.mp4"]


def test_embed_values_handles_indented_and_over_long_fences():
    """
    CommonMark, which is what `marked` implements: a fence may be indented by
    up to 3 spaces, and the closer may be LONGER than the opener. A regex with
    a `(?P=fence)` backreference gets both wrong -- the first draft here did.
    """
    indented = "\n".join([
        "   ```",
        "   ::embed[/uploadz/public/u/indented-fence.mp4]",
        "   ```",
        "::embed[/uploadz/public/u/real.mp4]",
    ])
    assert embed_values(indented) == ["/uploadz/public/u/real.mp4"]

    longer_close = "\n".join([
        "```",
        "::embed[/uploadz/public/u/in-a-fence.mp4]",
        "``````",
        "::embed[/uploadz/public/u/after.mp4]",
    ])
    assert embed_values(longer_close) == ["/uploadz/public/u/after.mp4"]

    # A tilde fence is not closed by backticks.
    mismatched = "\n".join([
        "~~~",
        "::embed[/uploadz/public/u/still-code.mp4]",
        "```",
        "::embed[/uploadz/public/u/also-still-code.mp4]",
    ])
    assert embed_values(mismatched) == []


def test_a_backtick_in_the_info_string_is_not_a_fence():
    """
    CommonMark forbids a backtick in a BACKTICK fence's info string, so this
    is an inline-code paragraph and `marked` renders the embed after it. If
    this scanner disagreed with the renderer, a real, visible video would be
    missing from `media` and from the JSON-LD -- silently.
    """
    content = "\n".join([
        "``` see `x` for details",
        "::embed[/uploadz/public/u/a.mp4]",
    ])
    assert embed_values(content) == ["/uploadz/public/u/a.mp4"]

    # A tilde fence has no such restriction: this one really is code.
    assert embed_values("\n".join([
        "~~~ see `x` for details",
        "::embed[/uploadz/public/u/b.mp4]",
    ])) == []


@pytest.mark.django_db
def test_another_creators_private_upload_is_never_resolved(creator_factory):
    """
    `content` is author-controlled and this runs on an ANONYMOUS request.

    Without owner scoping, writing someone else's upload URL into your own
    published page turns the zPage detail endpoint into an existence and
    metadata oracle over THEIR private files: title, description, upload
    time, access level, all readable by anyone who fetches the page.
    """
    author = creator_factory(username="bob")
    victim = creator_factory(username="carol")
    for access in ("private", "members"):
        secret = _video(victim, access=access, stem=f"secret-{access}",
                        with_poster=False)
        secret.title = "Unreleased"
        secret.save(update_fields=["title"])

        assert embedded_media(f"::embed[{secret.get_url()}]", author) == []
        #...and the same URL on the public prefix resolves to the same row,
        # so folding the prefix away cannot be used to get around it either.
        public_spelling = f"/uploadz/public/{secret.file.name}"
        assert embedded_media(f"::embed[{public_spelling}]", author) == []


@pytest.mark.django_db
def test_another_creators_public_upload_is_still_resolved(creator_factory):
    """A genuinely public upload discloses nothing the public tier does not."""
    author = creator_factory(username="bob")
    other = creator_factory(username="carol")
    video = _video(other, access="public", stem="shared")

    items = embedded_media(f"::embed[{video.get_url()}]", author)

    assert len(items) == 1
    assert items[0]["is_public"] is True


@pytest.mark.django_db
def test_no_creator_resolves_only_public_uploads(creator_factory):
    creator = creator_factory(username="bob")
    private = _video(creator, access="private", stem="mine")
    public = _video(creator, access="public", stem="ours")

    assert embedded_media(f"::embed[{private.get_url()}]", None) == []
    assert len(embedded_media(f"::embed[{public.get_url()}]", None)) == 1


@pytest.mark.django_db
def test_the_media_list_is_capped(creator_factory):
    """
    An anonymous request path with no cardinality ceiling is a load
    amplifier: one published page referencing thousands of uploads makes
    every fetch of it a thousand-row query and a thousand JSON-LD nodes.
    """
    creator = creator_factory(username="bob")
    videos = [
        _video(creator, stem=f"clip{index}")
        for index in range(MAX_EMBEDDED_MEDIA + 5)
    ]
    content = "\n".join(f"::embed[{video.get_url()}]" for video in videos)

    items = embedded_media(content, creator)

    # Pinned against the constant AND against an absolute bound, so raising
    # `MAX_EMBEDDED_MEDIA` to something that is not a bound cannot make this
    # test quietly agree with it.
    assert MAX_EMBEDDED_MEDIA <= 25
    assert len(items) == MAX_EMBEDDED_MEDIA
    assert len(items) < len(videos)
    # The first ones in document order, not an arbitrary slice.
    assert [item["url"] for item in items] == [
        video.get_url() for video in videos[:MAX_EMBEDDED_MEDIA]
    ]
