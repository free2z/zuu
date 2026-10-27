"""Comment.tuzis is a score; Creator.tuzis is the balance.

The two ``F('tuzis')`` writes in the comments app update ``Comment.tuzis``
(the comment's vote/AI score). The money moves through the ledger in the same
transaction. These tests pin the exact before/after of BOTH columns on every
branch, so a later refactor that routes either write through the ledger (or
drops the ledger call) shows up as a wrong number rather than a quiet change:

* upvote / downvote: voter -1 2Z, author balance unchanged, score +/-1
* vote with no balance: 402, nothing moves (balance, score, events)
* AI score > 0: author +score 2Z, score +score
* AI score < 0 with a smaller balance: author clamped to 0 (debit_up_to),
  Event records what actually moved, score still moves by the full score
"""
import uuid
from decimal import Decimal

import pytest

from dj.apps.comments.management.commands import aiscore_comments
from dj.apps.comments.models import Comment
from dj.apps.comments.test_aiscore_comments import Message
from dj.apps.events.models import Event
from dj.apps.g12f.models import Creator


def balance(creator):
    return Creator.objects.values_list("tuzis", flat=True).get(pk=creator.pk)


def score(comment):
    return Comment.objects.values_list("tuzis", flat=True).get(pk=comment.pk)


def _vote(api_client, voter, comment, direction):
    api_client.force_authenticate(user=voter)
    return api_client.post(
        f"/api/comments/{comment.uuid}/vote/",
        {"vote": direction},
        format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )


@pytest.mark.django_db
@pytest.mark.parametrize("direction,delta", [("up", 1), ("down", -1)])
def test_vote_debits_voter_and_moves_score_only(
    api_client, creator_factory, direction, delta
):
    author = creator_factory(username=f"sv-author-{direction}", tuzis=Decimal("5"))
    voter = creator_factory(username=f"sv-voter-{direction}", tuzis=Decimal("2.500"))
    comment = Comment.objects.create(author=author, content="c", tuzis=3)

    response = _vote(api_client, voter, comment, direction)

    assert response.status_code == 200, response.data
    assert balance(voter) == Decimal("1.500")
    assert balance(author) == Decimal("5")
    assert score(comment) == 3 + delta
    assert response.data["tuzis"] == str(3 + delta)
    assert Event.objects.get(type="VOTE_COMMENT_SENT", receiving_user=voter).amount == 1


@pytest.mark.django_db
def test_vote_without_balance_moves_nothing(api_client, creator_factory):
    author = creator_factory(username="sv-poor-author", tuzis=Decimal("5"))
    voter = creator_factory(username="sv-poor-voter", tuzis=Decimal("0.999"))
    comment = Comment.objects.create(author=author, content="c", tuzis=3)

    response = _vote(api_client, voter, comment, "up")

    assert response.status_code == 402
    assert response.data["code"] == "insufficient_funds"
    assert response.data["balance"] == "0.999"
    assert response.data["cost"] == "1.000"
    assert balance(voter) == Decimal("0.999")
    assert balance(author) == Decimal("5")
    assert score(comment) == 3
    assert not Event.objects.filter(type__startswith="VOTE_COMMENT").exists()


@pytest.mark.django_db(transaction=True)
def test_positive_ai_score_credits_author_and_score(creator_factory, monkeypatch):
    author = creator_factory(username="sv-ai-pos", tuzis=Decimal("10.250"))
    comment = Comment.objects.create(author=author, content="hello", tuzis=1)
    monkeypatch.setattr(aiscore_comments, "score_content", lambda _c: 4)

    aiscore_comments.callback(Message(comment))

    assert balance(author) == Decimal("14.250")
    assert score(comment) == 5
    assert Event.objects.get(
        type="AISCORE_COMMENT", object_id=str(comment.uuid)
    ).amount == 4


@pytest.mark.django_db(transaction=True)
def test_negative_ai_score_clamps_balance_not_score(creator_factory, monkeypatch):
    author = creator_factory(
        username="sv-ai-neg", tuzis=Decimal("1.500"), strikes=0
    )
    comment = Comment.objects.create(author=author, content="hello", tuzis=1)
    monkeypatch.setattr(aiscore_comments, "score_content", lambda _c: -3)

    aiscore_comments.callback(Message(comment))

    assert balance(author) == Decimal("0")  # clamped, never negative
    assert score(comment) == -2  # the score takes the full -3
    assert Event.objects.get(
        type="AISCORE_COMMENT", object_id=str(comment.uuid)
    ).amount == Decimal("-1.500")  # what actually moved
