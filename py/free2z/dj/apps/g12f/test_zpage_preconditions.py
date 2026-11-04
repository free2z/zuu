"""`ETag` / `If-Match` optimistic concurrency on zPage writes —.

The bug this pins is *silent*: two tabs edit an article, both save, and the
first creator's paragraphs are gone with no error anywhere. So the tests are
written around the thing that has to stay true rather than around the code:

1. **A read hands out a validator, and a write conditioned on it succeeds.**
   If the write path's validator and the read path's validator ever disagree,
   every save after a save 412s on a page nobody else touched — a far more
   visible outage than the bug being fixed, and the reason
   ``test_write_response_etag_matches_next_read`` exists.
2. **The second tab loses loudly.** Two clients read the same validator, one
   saves, the other gets 412 and the stored content is the first one's.
3. **No header, no change.** Every deployed client and every third-party API
   consumer sends no ``If-Match``; they must behave exactly as before.
4. **A counter that a reader moves does not fail a creator's save.** Tips move
   ``total``; that must not invalidate an editor's validator.
"""
import uuid
from datetime import timedelta

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from dj.apps.g12f.models import zPage, ZPageTranslation, ZPageVariant
from dj.apps.g12f.preconditions import canonical_etag, canonical_etag_from_db


def make_page(creator, **overrides):
    values = {
        "creator": creator,
        "free2zaddr": str(uuid.uuid4()),
        "title": "English title",
        "description": "English description",
        "content": "English body",
        "source_language": "en",
        "is_published": True,
    }
    values.update(overrides)
    return zPage.objects.create(**values)


def page_url(page):
    return f"/api/zpage/{page.free2zaddr}/"


def variant_url(page, language):
    return f"{page_url(page)}variants/{language}/"


def owner_client(creator):
    client = APIClient()
    client.force_authenticate(creator)
    return client


def patch_payload(**overrides):
    payload = {"tags": []}
    payload.update(overrides)
    return payload


# --------------------------------------------------------------------------
# The validator itself
# --------------------------------------------------------------------------

@pytest.mark.django_db
def test_read_emits_a_strong_etag(creator_factory):
    creator = creator_factory()
    page = make_page(creator)

    response = APIClient().get(page_url(page))

    assert response.status_code == 200
    etag = response["ETag"]
    # Strong, not weak: `If-Match` uses strong comparison (RFC 9110 §13.1.1),
    # so a `W/` prefix would make every precondition permanently unusable.
    assert etag.startswith('"') and etag.endswith('"')
    assert not etag.startswith("W/")


@pytest.mark.django_db
def test_instance_and_database_validators_agree(creator_factory):
    """The two code paths that compute the canonical validator must agree.

    Reads digest the loaded instance (no extra query on the hottest path in
    the app); writes digest a fresh ``.values()`` row (post-``post_save``
    truth). A type mismatch between those two renderings would make every
    second save 412 — invisible in any test that only exercises one of them.
    """
    creator = creator_factory()
    page = make_page(creator, goal=None, publish_at=None)

    assert canonical_etag(page) == canonical_etag_from_db(zPage, page.pk)

    page.goal = 7
    page.publish_at = page.created_at
    page.vanity = "a-vanity"
    page.save()
    page.refresh_from_db()

    assert canonical_etag(page) == canonical_etag_from_db(zPage, page.pk)


@pytest.mark.django_db
def test_write_response_etag_matches_next_read(creator_factory):
    """A save hands back the validator the next read will emit.

    Without this the editor's *next* autosave 412s against its own previous
    save, which looks exactly like a phantom conflict.
    """
    creator = creator_factory()
    page = make_page(creator)
    client = owner_client(creator)

    written = client.patch(
        page_url(page), patch_payload(content="second"), format="json"
    )
    assert written.status_code == 200

    read = client.get(page_url(page))
    assert read["ETag"] == written["ETag"]


@pytest.mark.django_db
def test_reader_activity_does_not_invalidate_an_editors_validator(
    creator_factory,
):
    """A tip moves `total`; it must not fail the creator's next save.

    The validator deliberately covers editable state rather than the rendered
    bytes. If it covered `total`, somebody sending money mid-sentence would
    turn the creator's autosave into a conflict — a worse bug than the one
     fixes.
    """
    creator = creator_factory()
    page = make_page(creator)
    client = owner_client(creator)
    etag = client.get(page_url(page))["ETag"]

    zPage.objects.filter(pk=page.pk).update(total=42, tuzi_total=42, f2z_score=9)

    response = client.patch(
        page_url(page),
        patch_payload(content="still mine"),
        format="json",
        HTTP_IF_MATCH=etag,
    )
    assert response.status_code == 200


# --------------------------------------------------------------------------
# The canonical article
# --------------------------------------------------------------------------

@pytest.mark.django_db
def test_matching_if_match_is_applied(creator_factory):
    creator = creator_factory()
    page = make_page(creator)
    client = owner_client(creator)
    etag = client.get(page_url(page))["ETag"]

    response = client.patch(
        page_url(page),
        patch_payload(content="edited"),
        format="json",
        HTTP_IF_MATCH=etag,
    )

    assert response.status_code == 200
    page.refresh_from_db()
    assert page.content == "edited"


@pytest.mark.django_db
def test_second_tab_loses_loudly_instead_of_clobbering(creator_factory):
    """The whole issue, in one test.

    Two tabs read the same article. The first saves. The second saves the body
    it has been holding — and must be told, not obeyed.
    """
    creator = creator_factory()
    page = make_page(creator)
    tab_one = owner_client(creator)
    tab_two = owner_client(creator)

    stale_etag = tab_two.get(page_url(page))["ETag"]

    first = tab_one.patch(
        page_url(page),
        patch_payload(content="tab one's paragraphs"),
        format="json",
    )
    assert first.status_code == 200

    second = tab_two.patch(
        page_url(page),
        patch_payload(content="tab two's stale body"),
        format="json",
        HTTP_IF_MATCH=stale_etag,
    )

    assert second.status_code == 412
    # Actionable, not "Failed to save article" —  calls that out by name.
    assert "reload" in second.data["detail"].lower()
    page.refresh_from_db()
    assert page.content == "tab one's paragraphs"


@pytest.mark.django_db
def test_no_if_match_header_keeps_legacy_behaviour(creator_factory):
    """Every deployed client and every API consumer sends no `If-Match`."""
    creator = creator_factory()
    page = make_page(creator)
    tab_one = owner_client(creator)
    tab_two = owner_client(creator)
    tab_two.get(page_url(page))

    assert tab_one.patch(
        page_url(page), patch_payload(content="one"), format="json"
    ).status_code == 200
    assert tab_two.patch(
        page_url(page), patch_payload(content="two"), format="json"
    ).status_code == 200

    page.refresh_from_db()
    assert page.content == "two"


@pytest.mark.django_db
@pytest.mark.parametrize("header", ['"not-the-etag"', "", "   ", ",", 'W/"x"'])
def test_unusable_if_match_values_fail_closed(creator_factory, header):
    """An empty or unparsable precondition is not the same as no precondition.

    A client that *meant* to send a validator and sent nothing usable must not
    be silently promoted to last-write-wins — that is how a concurrency
    control quietly stops working. `W/` is included because RFC 9110 strong
    comparison never matches a weak tag, and a "helpful" implementation that
    strips the prefix would pass this test only by breaking the RFC.
    """
    creator = creator_factory()
    page = make_page(creator)
    client = owner_client(creator)

    response = client.patch(
        page_url(page),
        patch_payload(content="edited"),
        format="json",
        HTTP_IF_MATCH=header,
    )

    assert response.status_code == 412
    page.refresh_from_db()
    assert page.content == "English body"


@pytest.mark.django_db
def test_star_if_match_requires_only_that_the_page_exists(creator_factory):
    creator = creator_factory()
    page = make_page(creator)
    client = owner_client(creator)

    response = client.patch(
        page_url(page),
        patch_payload(content="edited"),
        format="json",
        HTTP_IF_MATCH="*",
    )

    assert response.status_code == 200


@pytest.mark.django_db
def test_if_match_accepts_a_list_of_tags(creator_factory):
    creator = creator_factory()
    page = make_page(creator)
    client = owner_client(creator)
    etag = client.get(page_url(page))["ETag"]

    response = client.patch(
        page_url(page),
        patch_payload(content="edited"),
        format="json",
        HTTP_IF_MATCH=f'"someone-elses", {etag}',
    )

    assert response.status_code == 200


@pytest.mark.django_db
def test_put_honours_the_precondition(creator_factory):
    creator = creator_factory()
    page = make_page(creator)
    client = owner_client(creator)
    stale = client.get(page_url(page))["ETag"]
    zPage.objects.filter(pk=page.pk).update(content="moved on")

    response = client.put(
        page_url(page),
        patch_payload(title="t", content="whole body"),
        format="json",
        HTTP_IF_MATCH=stale,
    )

    assert response.status_code == 412
    page.refresh_from_db()
    assert page.content == "moved on"


@pytest.mark.django_db
def test_delete_honours_the_precondition(creator_factory):
    """DELETE is outside `AtomicMiddleware`'s verb set — see the view comment.

    If the route did not open its own transaction, `select_for_update()` would
    raise `TransactionManagementError` and this would be a 500, not a 412.
    """
    creator = creator_factory()
    page = make_page(creator)
    client = owner_client(creator)
    stale = client.get(page_url(page))["ETag"]
    zPage.objects.filter(pk=page.pk).update(content="somebody else edited")

    refused = client.delete(page_url(page), HTTP_IF_MATCH=stale)
    assert refused.status_code == 412
    assert zPage.objects.filter(pk=page.pk).exists()

    fresh = client.get(page_url(page))["ETag"]
    accepted = client.delete(page_url(page), HTTP_IF_MATCH=fresh)
    assert accepted.status_code == 204
    assert not zPage.objects.filter(pk=page.pk).exists()


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("is_published", "publish_at"),
    [
        (False, None),
        (False, timezone.now() + timedelta(days=1)),
        (True, None),
    ],
    ids=["draft", "scheduled-draft", "published"],
)
def test_owner_can_delete_every_publication_state(
    creator_factory, is_published, publish_at
):
    creator = creator_factory()
    page = make_page(
        creator,
        is_published=is_published,
        publish_at=publish_at,
    )

    response = owner_client(creator).delete(page_url(page))

    assert response.status_code == 204
    assert not zPage.objects.filter(pk=page.pk).exists()


@pytest.mark.django_db
@pytest.mark.parametrize("with_comment", [False, True],
                         ids=["payment", "onchain-comment"])
def test_delete_is_refused_not_500_when_payment_records_protect_the_page(
    creator_factory, with_comment
):
    """Legacy on-chain rows `PROTECT` a zPage; the delete must say so.

    Before, `ProtectedError` escaped `destroy` as a 500, which the dashboard
    and editor can only render as "check your connection" and which pages the
    site-wide 5xx alert. The refusal is correct and permanent, so it is a 409
    carrying an actionable `detail`, and nothing -- the article, its
    translations, the payment rows -- is deleted.
    """
    from dj.apps.g12f.models.comment import PageComment
    from dj.apps.g12f.models.transaction import Transaction

    creator = creator_factory()
    page = make_page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="fr", title="Titre", content="Corps",
    )
    tx = Transaction.objects.create(
        txid=uuid.uuid4().hex * 2, zpage=page, action="fund", amount=1,
    )
    if with_comment:
        tx.zpage = None
        tx.save(update_fields=["zpage"])
        PageComment.objects.create(zpage=page, tx=tx, comment="hi")

    client = owner_client(creator)
    client.raise_request_exception = False
    response = client.delete(page_url(page))

    assert response.status_code == 409, response.status_code
    assert "cannot be deleted" in response.json()["detail"]
    assert zPage.objects.filter(pk=page.pk).exists()
    assert ZPageTranslation.objects.filter(zpage=page, language="fr").exists()
    assert Transaction.objects.filter(pk=tx.pk).exists()


@pytest.mark.django_db
def test_non_owner_cannot_delete_a_zpage(creator_factory):
    owner = creator_factory()
    other_creator = creator_factory()
    page = make_page(owner)

    response = owner_client(other_creator).delete(page_url(page))

    assert response.status_code == 404
    assert zPage.objects.filter(pk=page.pk).exists()


@pytest.mark.django_db
def test_lang_selector_does_not_change_the_canonical_validator(creator_factory):
    """`?lang=` selects a representation; it never changes what a write writes.

    The canonical PUT/PATCH on this URL deliberately ignores `?lang=`,
    so the validator this URL hands out has to describe the canonical article
    or it would be a precondition on state the route cannot touch.
    """
    creator = creator_factory()
    page = make_page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="fr", title="fr", description="fr",
        content="corps", is_published=True,
    )
    client = APIClient()

    plain = client.get(page_url(page))["ETag"]
    localized = client.get(f"{page_url(page)}?lang=fr")

    assert localized.status_code == 200
    assert localized["ETag"] == plain


# --------------------------------------------------------------------------
# Variants
# --------------------------------------------------------------------------

@pytest.mark.django_db
def test_variant_read_emits_its_own_validator(creator_factory):
    creator = creator_factory()
    page = make_page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="fr", title="fr", description="fr",
        content="corps", is_published=True,
    )
    client = owner_client(creator)

    french = client.get(variant_url(page, "fr"))["ETag"]
    canonical = client.get(page_url(page))["ETag"]

    assert french != canonical


@pytest.mark.django_db
def test_variant_write_refuses_a_stale_validator(creator_factory):
    creator = creator_factory()
    page = make_page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="fr", title="fr", description="fr",
        content="corps", is_published=True,
    )
    client = owner_client(creator)
    stale = client.get(variant_url(page, "fr"))["ETag"]

    assert client.patch(
        variant_url(page, "fr"),
        patch_payload(content="quelqu'un d'autre"),
        format="json",
    ).status_code == 200

    refused = client.patch(
        variant_url(page, "fr"),
        patch_payload(content="ma version périmée"),
        format="json",
        HTTP_IF_MATCH=stale,
    )

    assert refused.status_code == 412
    assert ZPageTranslation.objects.get(
        zpage=page, language="fr"
    ).content == "quelqu'un d'autre"


@pytest.mark.django_db
def test_variant_validator_covers_both_shapes_of_the_row(creator_factory):
    """ is mid-rollout; the flag decides which shape *reads* answer from.

    Digesting only the read authority would make every in-flight editor's
    validator go stale the instant `ZPAGE_VARIANT_READS` flipped. Digesting
    both makes the validator authority-independent — so a change to the
    mirror-only shape still invalidates it.
    """
    creator = creator_factory()
    page = make_page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="fr", title="fr", description="fr",
        content="corps", is_published=True,
    )
    # The legacy write dual-writes its mirror through `g12f.signals`; assert
    # that rather than creating a second row, so this test also fails if the
    # dual write stops happening.
    assert ZPageVariant.objects.filter(zpage=page, language="fr").exists()
    client = owner_client(creator)
    etag = client.get(variant_url(page, "fr"))["ETag"]

    # Touch ONLY the mirror. With `ZPAGE_VARIANT_READS` off (the default and
    # the documented rollback state) this row is not what the read renders, so
    # a validator derived from the read authority alone would not move.
    ZPageVariant.objects.filter(zpage=page, language="fr").update(
        content="mirror moved"
    )

    refused = client.patch(
        variant_url(page, "fr"),
        patch_payload(content="x"),
        format="json",
        HTTP_IF_MATCH=etag,
    )
    assert refused.status_code == 412


@pytest.mark.django_db
def test_if_match_on_a_variant_that_does_not_exist_is_412(creator_factory):
    """Including `*`: RFC 9110 says `*` asserts a representation exists.

    A `PUT` that *creates* a variant carries no `If-Match` (the client never
    read one), so creation is unaffected — which
    `test_creating_a_variant_without_if_match_still_works` pins.
    """
    creator = creator_factory()
    page = make_page(creator)
    client = owner_client(creator)

    for header in ('"anything"', "*"):
        response = client.put(
            variant_url(page, "de"),
            patch_payload(title="de", content="Körper"),
            format="json",
            HTTP_IF_MATCH=header,
        )
        assert response.status_code == 412, header
    assert not ZPageTranslation.objects.filter(
        zpage=page, language="de"
    ).exists()


@pytest.mark.django_db
def test_creating_a_variant_without_if_match_still_works(creator_factory):
    creator = creator_factory()
    page = make_page(creator)
    client = owner_client(creator)

    response = client.put(
        variant_url(page, "de"),
        patch_payload(title="de", content="Körper"),
        format="json",
    )

    assert response.status_code == 200
    assert response["ETag"]


@pytest.mark.django_db
def test_variant_write_response_etag_matches_next_read(creator_factory):
    creator = creator_factory()
    page = make_page(creator)
    client = owner_client(creator)

    written = client.put(
        variant_url(page, "de"),
        patch_payload(title="de", content="Körper", is_published=True),
        format="json",
    )
    assert written.status_code == 200

    read = client.get(variant_url(page, "de"))
    assert read.status_code == 200
    assert read["ETag"] == written["ETag"]


@pytest.mark.django_db
def test_source_language_variant_shares_the_canonical_validator(creator_factory):
    """The source is a variant like any other ( §3.1).

    A write to `/variants/en/` on an `en` article writes the canonical
    columns, so its precondition has to be the canonical one — otherwise the
    two routes could each pass a precondition the other's state had already
    invalidated.
    """
    creator = creator_factory()
    page = make_page(creator)
    client = owner_client(creator)

    assert (
        client.get(variant_url(page, "en"))["ETag"]
        == client.get(page_url(page))["ETag"]
    )


@pytest.mark.django_db
def test_variant_delete_honours_the_precondition(creator_factory):
    creator = creator_factory()
    page = make_page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="fr", title="fr", description="fr",
        content="corps", is_published=True,
    )
    client = owner_client(creator)
    stale = client.get(variant_url(page, "fr"))["ETag"]
    ZPageTranslation.objects.filter(zpage=page, language="fr").update(
        content="retravaillé"
    )

    refused = client.delete(variant_url(page, "fr"), HTTP_IF_MATCH=stale)
    assert refused.status_code == 412
    assert ZPageTranslation.objects.filter(zpage=page, language="fr").exists()

    fresh = client.get(variant_url(page, "fr"))["ETag"]
    accepted = client.delete(variant_url(page, "fr"), HTTP_IF_MATCH=fresh)
    assert accepted.status_code == 204


@pytest.mark.django_db
def test_deprecated_translation_alias_honours_the_precondition(creator_factory):
    """The alias runs the same code, so it gets the same guarantee.

    An alias whose behaviour has drifted from the thing it aliases is worse
    than no alias — the deployed editor still calls this path.
    """
    creator = creator_factory()
    page = make_page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="fr", title="fr", description="fr",
        content="corps", is_published=True,
    )
    client = owner_client(creator)
    stale = client.get(variant_url(page, "fr"))["ETag"]
    ZPageTranslation.objects.filter(zpage=page, language="fr").update(
        content="retravaillé"
    )

    refused = client.put(
        f"{page_url(page)}translations/fr/",
        patch_payload(title="fr", content="périmé"),
        format="json",
        HTTP_IF_MATCH=stale,
    )
    assert refused.status_code == 412


# --------------------------------------------------------------------------
# The contract
# --------------------------------------------------------------------------

@pytest.mark.django_db
def test_if_match_is_declared_in_the_generated_schema():
    """A write-shaping header that a generated client cannot see does not ship.

    CLAUDE.md's rule, and the reason this is a test rather than a note: orval
    emits nothing for `in: header`, so nothing else in CI would ever notice
    the declaration disappearing.
    """
    from drf_spectacular.generators import SchemaGenerator

    schema = SchemaGenerator().get_schema(request=None, public=True)
    paths = schema["paths"]

    conditional = {
        ("/api/zpage/{id}/", "put"),
        ("/api/zpage/{id}/", "patch"),
        ("/api/zpage/{id}/", "delete"),
        ("/api/zpage/{id}/variants/{language}/", "put"),
        ("/api/zpage/{id}/variants/{language}/", "patch"),
        ("/api/zpage/{id}/variants/{language}/", "delete"),
    }
    for path, method in sorted(conditional):
        operation = paths[path][method]
        headers = {
            parameter["name"]
            for parameter in operation.get("parameters", [])
            if parameter.get("in") == "header"
        }
        assert "If-Match" in headers, (path, method)
        assert "412" in operation["responses"], (path, method)


@pytest.mark.django_db
def test_variant_validator_covers_the_shared_article_fields(creator_factory):
    """A variant PUT can rewrite the parent row, so its validator must sign it.

    `zPageUpdateSerializer` routes only title/description/content/is_published
    to the translation row. `vanity`, `p2paddr`, `canonical_url`, `category`,
    `featured_image`, `is_subscriber_only` and `tags` all go straight onto the
    `zPage`. A validator that signed the translation alone would let a stale
    French editor pass its precondition and *restore a payout address the
    creator had just rotated away from* — the conditional write undoing the
    change it exists to protect. (codex adversarial review.)
    """
    creator = creator_factory()
    page = make_page(creator, p2paddr="")
    ZPageTranslation.objects.create(
        zpage=page, language="fr", title="fr", description="fr",
        content="corps", is_published=True,
    )
    client = owner_client(creator)
    stale = client.get(variant_url(page, "fr"))["ETag"]

    # The creator rotates the payout address from another tab. Nothing about
    # the French translation row changed.
    assert client.patch(
        page_url(page),
        patch_payload(p2paddr=""),
        format="json",
    ).status_code == 200
    zPage.objects.filter(pk=page.pk).update(
        p2paddr="zs1rotated", is_subscriber_only=True
    )

    refused = client.put(
        variant_url(page, "fr"),
        patch_payload(title="fr", content="corps", p2paddr=""),
        format="json",
        HTTP_IF_MATCH=stale,
    )

    assert refused.status_code == 412
    page.refresh_from_db()
    assert page.p2paddr == "zs1rotated"
    assert page.is_subscriber_only is True


@pytest.mark.django_db
def test_create_response_carries_the_new_articles_validator(creator_factory):
    """Otherwise the tab that created a draft saves unconditionally forever.

    It holds no validator for a page it never read, so a second tab could open
    that draft, edit it, and be overwritten — the exact bug, on a page that is
    minutes old. (codex adversarial review.)
    """
    creator = creator_factory()
    client = owner_client(creator)

    created = client.post(
        "/api/zpage/",
        patch_payload(title="New", content="Body"),
        format="json",
    )

    assert created.status_code in (200, 201), created.data
    etag = created["ETag"]
    assert etag

    read = client.get(
        f"/api/zpage/{created.data['free2zaddr']}/?mine=true"
    )
    assert read["ETag"] == etag


@pytest.mark.django_db
def test_if_match_is_usable_from_a_cross_origin_browser_client():
    """Declaring a header the browser cannot send is a documented no-op.

    `corsheaders`' `default_headers` contains neither `If-Match` nor an
    exposure for `ETag`, so without the settings entries a cross-origin client
    fails preflight on the request header and cannot read the response one —
    silently degrading to last-write-wins. Same trap `Idempotency-Key` hit.
    (codex adversarial review.)
    """
    from django.conf import settings

    assert "if-match" in [h.lower() for h in settings.CORS_ALLOW_HEADERS]
    assert "etag" in [h.lower() for h in settings.CORS_EXPOSE_HEADERS]


@pytest.mark.django_db
def test_a_tag_added_outside_the_serializer_invalidates_the_validator(
    creator_factory,
):
    """`updated_at` does not cover tags, and the docstring used to say it did.

    `dj.apps.tagging.services` accepts an AI tag suggestion with a bare
    `zpage.tags.add(...)` — no `save()`, so no column on `zPage` moves. Without
    tags in the digest, a creator could accept a suggested tag on one surface
    and have their next conditional autosave pass its precondition and quietly
    remove it again. (codex adversarial review.)
    """
    creator = creator_factory()
    page = make_page(creator)
    client = owner_client(creator)
    etag = client.get(page_url(page))["ETag"]

    # Exactly what the tag-suggestion accept path does.
    page.tags.add("zcash")

    refused = client.patch(
        page_url(page),
        patch_payload(content="edited", tags=[]),
        format="json",
        HTTP_IF_MATCH=etag,
    )

    assert refused.status_code == 412
    assert sorted(page.tags.names()) == ["zcash"]


@pytest.mark.django_db
def test_delete_precondition_does_not_cover_translations(creator_factory):
    """A DECISION, pinned so it cannot decay into an oversight.

    `DELETE /api/zpage/{id}/` cascades to every variant, and the canonical
    validator signs only the article's own fields — so a translation written
    after the client read its ETag does NOT refuse the delete. Widening the
    validator was rejected because the cost lands on the common path: the
    editor buys AI translations itself, so a draft variant landing while the
    creator writes the source would invalidate their own validator and report
    it as somebody else's edit. See the module docstring in
    `preconditions.py`. (codex adversarial review.)
    """
    creator = creator_factory()
    page = make_page(creator)
    client = owner_client(creator)
    etag = client.get(page_url(page))["ETag"]

    # A translation-only write. It changes no column on the parent row, so the
    # canonical validator legitimately still matches.
    assert client.put(
        variant_url(page, "fr"),
        patch_payload(title="fr", content="corps"),
        format="json",
    ).status_code == 200
    assert client.get(page_url(page))["ETag"] == etag

    accepted = client.delete(page_url(page), HTTP_IF_MATCH=etag)

    assert accepted.status_code == 204
    assert not zPage.objects.filter(pk=page.pk).exists()
    assert not ZPageTranslation.objects.filter(zpage_id=page.pk).exists()


@pytest.mark.django_db
def test_both_translation_routes_return_the_same_validator(creator_factory):
    """The alias and the  route address one resource, so one validator.

    The editor still SAVES through `/translations/{lang}/` and DELETES through
    `/variants/{lang}/`. If those two returned different validators the client
    could not key its registry by resource, and its save and its delete would
    drift apart. (codex adversarial review.)
    """
    creator = creator_factory()
    page = make_page(creator)
    client = owner_client(creator)

    saved = client.put(
        f"{page_url(page)}translations/fr/",
        patch_payload(title="fr", content="corps"),
        format="json",
    )
    assert saved.status_code == 200

    assert client.get(
        f"{variant_url(page, 'fr')}?mine=true"
    )["ETag"] == saved["ETag"]
    # And that validator is immediately usable on the DELETE route.
    assert client.delete(
        variant_url(page, "fr"), HTTP_IF_MATCH=saved["ETag"]
    ).status_code == 204



# --------------------------------------------------------------------------
#the language detector is not a second editor
# --------------------------------------------------------------------------
#
# Production, 2026-09-18..26: 7 of the 8 canonical 412s came 3-67 s after a
# `detect_zpage_language: zPage N -> <tag>` completion. The detector relabels
# `source_language` in the background a few minutes after a save, and that
# column is in the validator, so the creator's very next autosave was refused
# with "This page changed since you loaded it" while nobody else was there.

SPANISH_TITLE = "Mensajeria cifrada en free2z"
SPANISH_BODY = (
    "Este articulo esta escrito en espanol y describe como funcionan los "
    "mensajes cifrados entre los creadores y las personas que los apoyan."
)
SAW = "HTTP_X_FREE2Z_SOURCE_LANGUAGE"


def _detect(page, tag):
    """Run the real detection task with the provider answer pinned."""
    from f2z.ai import language as lang

    from dj.apps.g12f import tasks

    original = lang.detect_language
    lang.detect_language = lambda *a, **k: lang.LanguageDetection(
        tag, lang.CONFIDENCE_STRONG
    )
    try:
        assert tasks.detect_zpage_language(page.pk) is True
    finally:
        lang.detect_language = original
    page.refresh_from_db()
    assert page.source_language == tag
    assert page.language_source == "detected"


def _created_through_the_api(client):
    """A page the way the Svelte editor makes one: the UI locale as a guess."""
    created = client.post(
        "/api/zpage/",
        {
            "title": SPANISH_TITLE,
            "content": SPANISH_BODY,
            "source_language": "en",
            "is_published": False,
            "tags": [],
        },
        format="json",
    )
    assert created.status_code == 201
    page = zPage.objects.get(free2zaddr=created.data["free2zaddr"])
    assert page.language_source is None
    return page, created["ETag"]


def _editor_autosave(**overrides):
    """What `buildSavePayload()` sends on an update: no `source_language`."""
    payload = {
        "title": SPANISH_TITLE,
        "content": SPANISH_BODY + " Un parrafo mas.",
        "description": "",
        "tags": [],
        "is_published": False,
    }
    payload.update(overrides)
    return payload


@pytest.mark.django_db
def test_detection_relabel_does_not_fail_the_creators_next_autosave(
    creator_factory,
):
    """The  sequence: save -> detection relabels -> autosave, old ETag."""
    creator = creator_factory()
    client = owner_client(creator)
    page, etag = _created_through_the_api(client)

    _detect(page, "es")

    saved = client.put(
        page_url(page), _editor_autosave(), format="json",
        HTTP_IF_MATCH=etag, **{SAW: "en"},
    )

    assert saved.status_code == 200, saved.data
    page.refresh_from_db()
    assert page.content.endswith("Un parrafo mas.")
    # The autosave did not undo the detection, and did not turn it into a
    # creator decision (which would lock the detector out forever).
    assert page.source_language == "es"
    assert page.language_source == "detected"
    # The response carries the label the editor now has to follow, and the
    # validator the next read will emit.
    assert saved.data["source_language"] == "es"
    assert client.get(page_url(page))["ETag"] == saved["ETag"]


@pytest.mark.django_db
def test_a_client_that_does_not_say_what_it_saw_keeps_the_strict_check(
    creator_factory,
):
    """Every editor bundle older than  sends no header on this route.

    Such a bundle cannot follow a relabel: let through, it adopts `es` from
    the response, stops recognising `en` as the article, and PUTs the body to
    `/translations/en/` as a brand-new translation on its next autosave. So it
    keeps getting the 412 and the reload that comes with it.
    """
    creator = creator_factory()
    client = owner_client(creator)
    page, etag = _created_through_the_api(client)
    _detect(page, "es")

    refused = client.put(
        page_url(page), _editor_autosave(), format="json", HTTP_IF_MATCH=etag,
    )

    assert refused.status_code == 412


@pytest.mark.django_db
def test_a_second_editors_change_still_412s_across_a_detection(
    creator_factory,
):
    """Overlooking the detector must not overlook a human."""
    creator = creator_factory()
    tab_one = owner_client(creator)
    tab_two = owner_client(creator)
    page, _ = _created_through_the_api(tab_one)
    stale = tab_two.get(page_url(page))["ETag"]

    assert tab_one.patch(
        page_url(page), patch_payload(content="tab one's paragraphs"),
        format="json",
    ).status_code == 200
    _detect(page, "es")

    refused = tab_two.put(
        page_url(page), _editor_autosave(content="tab two's stale body"),
        format="json", HTTP_IF_MATCH=stale, **{SAW: "en"},
    )

    assert refused.status_code == 412
    page.refresh_from_db()
    assert page.content == "tab one's paragraphs"


@pytest.mark.django_db
def test_a_second_editors_relabel_still_412s(creator_factory):
    """A HUMAN relabel is a real change, whatever label the client claims."""
    creator = creator_factory()
    tab_one = owner_client(creator)
    tab_two = owner_client(creator)
    page, _ = _created_through_the_api(tab_one)
    stale = tab_two.get(page_url(page))["ETag"]

    assert tab_one.patch(
        page_url(page), {"source_language": "es"}, format="json",
    ).status_code == 200
    page.refresh_from_db()
    assert page.language_source == "creator"

    refused = tab_two.put(
        page_url(page), _editor_autosave(), format="json",
        HTTP_IF_MATCH=stale, **{SAW: "en"},
    )
    assert refused.status_code == 412


@pytest.mark.django_db
def test_a_stale_label_write_after_detection_still_412s(creator_factory):
    """A write that SETS the label gets no allowance for the detector.

    A full-object client echoing back the `en` it read is indistinguishable
    from a creator re-choosing `en` on stale information; passing it would
    mint `language_source='creator'` on a stale value and lock the detector
    out of the page for good.
    """
    creator = creator_factory()
    client = owner_client(creator)
    page, etag = _created_through_the_api(client)
    _detect(page, "es")

    refused = client.put(
        page_url(page), _editor_autosave(source_language="en"),
        format="json", HTTP_IF_MATCH=etag, **{SAW: "en"},
    )

    assert refused.status_code == 412
    page.refresh_from_db()
    assert page.source_language == "es"
    assert page.language_source == "detected"

    # Echoing the CURRENT label is not a label write.
    echoed = client.put(
        page_url(page), _editor_autosave(source_language="es"),
        format="json", HTTP_IF_MATCH=etag, **{SAW: "en"},
    )
    assert echoed.status_code == 200, echoed.data


@pytest.mark.django_db
def test_a_wrong_claimed_label_does_not_unlock_anything(creator_factory):
    """The allowance is one exact digest, not "any header will do"."""
    creator = creator_factory()
    client = owner_client(creator)
    page, etag = _created_through_the_api(client)
    _detect(page, "es")

    for claimed in ("fr", "es", "und", " "):
        assert client.put(
            page_url(page), _editor_autosave(), format="json",
            HTTP_IF_MATCH=etag, **{SAW: claimed},
        ).status_code == 412, claimed


@pytest.mark.django_db
@pytest.mark.parametrize("route", ["variants", "translations"])
def test_a_translation_autosave_survives_a_source_relabel(
    creator_factory, route,
):
    """A translation's validator embeds the canonical one; same allowance.

    The editor already sends the header on every translation save (to the
    deprecated `/translations/` alias, which runs the same code).
    """
    creator = creator_factory()
    client = owner_client(creator)
    page, _ = _created_through_the_api(client)
    ZPageTranslation.objects.create(
        zpage=page, language="fr", title="fr", description="fr",
        content="corps", is_published=False,
    )
    # Read from the variant route; both write routes share its validator
    # (`test_both_translation_routes_return_the_same_validator`).
    french = client.get(variant_url(page, "fr"))["ETag"]

    _detect(page, "es")

    def translator_autosave(content):
        return {"title": "fr", "description": "fr", "content": content,
                "tags": [], "is_published": False}

    assert client.put(
        f"{page_url(page)}{route}/fr/", translator_autosave("sans en-tete"),
        format="json", HTTP_IF_MATCH=french,
    ).status_code == 412
    saved = client.put(
        f"{page_url(page)}{route}/fr/", translator_autosave("corps modifie"),
        format="json", HTTP_IF_MATCH=french, **{SAW: "en"},
    )
    assert saved.status_code == 200, saved.data
    assert ZPageTranslation.objects.get(
        zpage=page, language="fr"
    ).content == "corps modifie"
