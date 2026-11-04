"""
Subscribes to new comments and scores them
"""
import sys
import json
import os
import traceback

from django.core.management.base import BaseCommand
# from django.contrib.contenttypes.models import ContentType
from django.conf import settings
from django.utils import timezone

from gcp.pubsub.client import PubSubClient
from f2z.openai.util import score_content

from dj.apps.g12f.models import Creator
from dj.apps.comments.models import Comment
from dj.apps.events.models import Event
from dj.apps.tuzis import ledger
from dj.apps.tuzis import models as idempotency

import openai

from django.db import DatabaseError, close_old_connections, transaction
from django.db.models import F


class RetryableScoringFailure(Exception):
    """Database scoring failed without committing its idempotency marker."""


def catch_errors(callback):
    def wrapper(message):
        try:
            close_old_connections()
            callback(message)
        except (RetryableScoringFailure, openai.OpenAIError, DatabaseError):
            # Unlike malformed poison messages, provider and database failures
            # are safe and necessary to retry. If nack() itself fails, let that
            # exception escape so Pub/Sub still sees an unacknowledged message.
            traceback.print_exc()
            message.nack()
        except Exception:
            # log the traceback
            traceback.print_exc()
            # acknowledge the message
            message.ack()
    return wrapper


def finish_duplicate_delivery(message, duplicate):
    if duplicate.in_flight:
        # Do not acknowledge work whose original delivery has not committed.
        # Pub/Sub will redeliver it; once the claim is either finished or old
        # enough to take over, that delivery can settle.
        raise RetryableScoringFailure()
    else:
        # The score, money move and moderation effects already committed.
        message.ack()


@catch_errors
def callback(message):
    # print(message)
    sys.stdout.flush()
    # Convert the message data to a dictionary
    data = json.loads(message.data.decode('utf-8'))
    content = data['content']

    # The database relationship is authoritative. Besides avoiding trust in a
    # stale username copied into the Pub/Sub payload, loading the Comment first
    # gives us the stable provider-independent idempotency key.
    comment = Comment.objects.select_related('author').get(uuid=data['uuid'])
    user = comment.author
    print("saving user", user)

    claim_kwargs = {
        'scope': 'aiscore_comment',
        'user': user,
        'key': str(comment.uuid),
    }

    # A completed or actively-running duplicate must never buy another OpenAI
    # call. Do not claim brand-new work yet, though: the provider call is
    # unbounded while claims become eligible for takeover after 15 minutes.
    # Holding a claim across that call could let a slow-but-live scorer overlap
    # its takeover. The authoritative claim after scoring resolves every race.
    existing = idempotency.IdempotencyKey.objects.filter(
        **claim_kwargs).first()
    if existing is not None:
        if existing.response_status is not None:
            message.ack()
            return
        if timezone.now() - existing.created_at <= idempotency.STALE_CLAIM:
            raise RetryableScoringFailure()
        # An unfinished stale claim is eligible for takeover. Score first, then
        # let claim() rotate ownership atomically before any database effect.

    # Concurrent first deliveries may both reach the provider, but only one
    # can win the claim below and apply database effects.
    try:
        score = score_content(content)
    except Exception as exc:
        # The scorer is an external boundary. Besides OpenAI's typed failures,
        # client initialization and response-shape failures may surface as
        # ordinary exceptions; losing the delivery would permanently skip the
        # score. Payload parsing and comment resolution happen above and retain
        # the poison-message ACK behavior.
        raise RetryableScoringFailure() from exc
    print("score", score)

    try:
        claim = idempotency.claim(**claim_kwargs)
    except idempotency.DuplicateRequest as duplicate:
        finish_duplicate_delivery(message, duplicate)
        return

    try:
        # The idempotency result and every database effect commit together.
        # If this block rolls back, release() below makes a retry eligible to
        # do the work. If it commits but ack() is lost, the finished claim
        # makes the redelivery a no-op.
        with transaction.atomic():
            # ban_and_soft_delete() performs a full Creator.save(). Load a
            # fresh instance after the row lock so it cannot restore a stale
            # balance while applying moderation.
            # Creator is locked before Comment, as in comment voting. The helper's
            # FOR NO KEY UPDATE is intentional: it is the same strength as a
            # balance UPDATE and keeps foreign-key inserts compatible.
            ledger.lock_in_order(user)
            user = Creator.objects.get(pk=user.pk)
            comment = Comment.objects.select_for_update().get(pk=comment.pk)

            # A zero score still finishes the claim. Otherwise an identical
            # redelivery could be scored again and receive a different,
            # money-moving LLM result.
            if score > 0:
                # The reward: `sys:promo -> user`, named after the comment and
                # keyed on the same identity as the idempotency claim above.
                ledger.credit(
                    user, score,
                    source="sys:promo",
                    ref_kind="comment_score",
                    ref_id=str(comment.pk),
                    idem=f"comment_score:{comment.uuid}",
                )
                moved = score
            elif score < 0:
                # A clamped debit moves less than the score implies; the
                # Event must report what actually moved or the audit trail
                # stops reconciling with balances. (codex review.)
                moved = -ledger.debit_up_to(user, -score, action="comment_score")
            if score < 0:
                now = timezone.now()
                Creator.objects.filter(pk=user.pk).update(
                    strikes=F('strikes') + 1,
                    updated_at=now,
                )
                user.refresh_from_db(fields=['strikes'])
            if score != 0:
                # Comment.tuzis is the comment's SCORE, not a balance; the
                # author's 2Z moved through the ledger above. Allowlisted in
                # tuzis/test_ledger_only_balance_writers.py.
                Comment.objects.filter(pk=comment.pk).update(
                    tuzis=F('tuzis') + score)
                comment.refresh_from_db(fields=['tuzis'])
                print("saving comment", comment)

                # comment_content_type = ContentType.objects.get_for_model(comment)
                Event.objects.create(
                    receiving_user=user,
                    amount=moved,
                    type="AISCORE_COMMENT",
                    # content_type=comment_content_type,
                    # object_id=comment.id,
                    content_object=comment,
                )

            if user.strikes >= 3 and user.tuzis < 33:
                print("banning user", user)
                user.ban_and_soft_delete()

            claim.finish(status=200)
    except Exception as exc:
        # No database effect committed. Release if possible, then classify the
        # delivery as retryable even if that cleanup itself fails. A surviving
        # claim makes redeliveries wait until the safe stale takeover window;
        # it must never make the outer poison-message handler ACK this away.
        try:
            idempotency.release(claim)
        except Exception:
            traceback.print_exc()
        raise RetryableScoringFailure() from exc

    print("acknowledging message")
    sys.stdout.flush()
    message.ack()


class Command(BaseCommand):
    def handle(self, *args, **options):
        print("aiscore_comments Listening for new comments...")
        sys.stdout.flush()
        ps = PubSubClient()

        ps.subscribe(
            settings.PUBSUB["NEW_COMMENT"]["topic"],
            settings.PUBSUB["NEW_COMMENT"]["AISCORE"],
            callback,
        )


print("aiscore_comments loaded")
