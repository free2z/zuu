"""A comment POST without ``tuzis`` is a 400, never a 500.

``Comment.tuzis`` has a model default, so DRF inferred ``required=False`` for
``CommentListSerializer.tuzis``. DRF does not put model defaults into
``validated_data``, and every create route prices the comment by indexing
``validated_data['tuzis']`` -- so omitting the field raised ``KeyError`` and
returned a 500 (12 of them in prod on 2026-09-26, paging twice).

Each create route must refuse the request at validation: 400 naming the
field, no debit, no idempotency claim, no Comment row. Real Postgres -- the DB
is never mocked (project rule).
"""
import uuid
from decimal import Decimal

import pytest

from dj.apps.comments.models import Comment
from dj.apps.g12f.models import zPage
from dj.apps.tuzis.models import IdempotencyKey


pytestmark = pytest.mark.django_db


@pytest.fixture
def author(creator_factory):
    return creator_factory(username="tuzis-required", tuzis=Decimal("10"))


def _zpage(owner):
    return zPage.objects.create(
        creator=owner,
        title="t",
        content="c",
        free2zaddr=str(uuid.uuid4()),
        vanity=f"tuzis-required-{owner.username}",
        is_published=True,
    )


def _post(api_client, url, body, with_key):
    extra = {"HTTP_IDEMPOTENCY_KEY": str(uuid.uuid4())} if with_key else {}
    return api_client.post(url, body, format="json", **extra)


def _assert_refused_without_side_effects(response, author, rows_before):
    assert response.status_code == 400, response.content
    assert "tuzis" in response.data, response.data
    author.refresh_from_db()
    assert author.tuzis == Decimal("10")
    assert Comment.objects.count() == rows_before
    assert not IdempotencyKey.objects.filter(user=author).exists()


@pytest.mark.parametrize("with_key", [True, False])
def test_root_comment_without_tuzis_is_400(api_client, author, with_key):
    api_client.force_authenticate(user=author)
    before = Comment.objects.count()

    response = _post(
        api_client, "/api/comments/", {"content": "no amount"}, with_key
    )

    _assert_refused_without_side_effects(response, author, before)


@pytest.mark.parametrize("with_key", [True, False])
def test_zpage_comment_without_tuzis_is_400(api_client, author, with_key):
    page = _zpage(author)
    api_client.force_authenticate(user=author)
    before = Comment.objects.count()

    response = _post(
        api_client,
        f"/api/comments/zpage/{page.free2zaddr}/",
        {"content": "no amount"},
        with_key,
    )

    _assert_refused_without_side_effects(response, author, before)


@pytest.mark.parametrize("with_key", [True, False])
def test_reply_without_tuzis_is_400(api_client, author, with_key):
    parent = Comment.objects.create(author=author, content="parent", tuzis=1)
    api_client.force_authenticate(user=author)
    before = Comment.objects.count()

    response = _post(
        api_client,
        f"/api/comments/{parent.uuid}/replies/",
        {"content": "no amount"},
        with_key,
    )

    _assert_refused_without_side_effects(response, author, before)


def test_null_tuzis_is_400_not_500(api_client, author):
    """An explicit ``null`` must not slip past as ``None`` into ``< 1``."""
    api_client.force_authenticate(user=author)
    before = Comment.objects.count()

    response = _post(
        api_client, "/api/comments/", {"content": "null", "tuzis": None}, True
    )

    _assert_refused_without_side_effects(response, author, before)


def test_supplied_tuzis_still_creates_and_charges(api_client, author):
    """Positive control: the UI always sends ``tuzis`` and must be unaffected."""
    page = _zpage(author)
    api_client.force_authenticate(user=author)

    response = _post(
        api_client,
        f"/api/comments/zpage/{page.free2zaddr}/",
        {"content": "paid", "tuzis": 2},
        True,
    )

    assert response.status_code == 201, response.content
    author.refresh_from_db()
    assert author.tuzis == Decimal("8")


@pytest.mark.parametrize("method", ["put", "patch"])
def test_edit_does_not_require_tuzis(api_client, author, method):
    """Edits never carry an amount (read-only on PUT/PATCH); keep it that way."""
    comment = Comment.objects.create(author=author, content="old", tuzis=3)
    api_client.force_authenticate(user=author)

    response = getattr(api_client, method)(
        f"/api/comments/{comment.uuid}/", {"content": "new"}, format="json"
    )

    assert response.status_code == 200, response.content
    comment.refresh_from_db()
    assert comment.content == "new"
    assert comment.tuzis == 3
