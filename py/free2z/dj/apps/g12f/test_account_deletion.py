"""Self-service account deletion (``/api/auth/account-deletion/``).

Real Postgres through the real endpoint. What each test protects:

* the policy covers every relation to an account, so a new table of personal
  data cannot silently outlive a deletion;
* a burner account -- no email, wallet sign-in only -- deletes completely, and
  every credential it held stops working, while its ledger stays;
* nothing changes without a recent sign-in, or when the typed username is not
  the signed-in account (a persona switch mid-flow);
* a blocker changes nothing;
* other people's data -- replies, another persona -- survives.
"""
from __future__ import annotations

import uuid
import time
import threading
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from io import BytesIO
from queue import Queue
from types import SimpleNamespace

import pytest
from django.contrib.contenttypes.models import ContentType
from django.core.files.base import ContentFile
from django.db import connection, connections, transaction
from django.utils import timezone
from knox.models import AuthToken
from PIL import Image
from rest_framework.test import APIClient

from dj.apps.comments.models import Comment
from dj.apps.g12f import account_deletion
from dj.apps.g12f.models import Creator, CreatorFollow, zPage
from dj.apps.handles.models import MessagingHandle
from dj.apps.identity.models import AuthContext
from dj.apps.ledger import api as ledger_api
from dj.apps.tuzis.models import IdempotencyKey
from dj.apps.uploads.models import GenericFile, PendingUploadBlobDeletion
from dj.apps.zauth.models import ZcashIdentity

pytestmark = pytest.mark.django_db

URL = "/api/auth/account-deletion/"
SCHEDULE_URL = "/api/auth/account-deletion/schedule/"
ZADDR = "t1VpYecBW4UudbGcy4ufh61eWxQCoFaUrPs"


@pytest.fixture(autouse=True)
def _local_media(settings, tmp_path):
    # Only the external boundary (GCS) is swapped; the database is real.
    settings.STORAGES = {
        **settings.STORAGES,
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    }
    settings.MEDIA_ROOT = str(tmp_path)


def _png():
    out = BytesIO()
    Image.new("RGB", (8, 8), (1, 2, 3)).save(out, format="PNG")
    return out.getvalue()


def _page(creator):
    return zPage.objects.create(
        creator=creator, free2zaddr=str(uuid.uuid4()), title="My page",
        description="d", content="private thoughts", is_published=True,
    )


def _comment(page, author, content, parent=None):
    return Comment.objects.create(
        author=author, content=content, parent=parent,
        content_type=ContentType.objects.get_for_model(zPage),
        object_id=str(page.pk),
    )


@pytest.fixture
def burner(creator_factory):
    """A wallet-only account with no email: the case that must not need one."""
    user = creator_factory(username="burner_42", tuzis=Decimal("0"))
    user.set_unusable_password()
    user.full_name = "Real Name"
    user.description = "bio"
    user.save()
    ZcashIdentity.objects.create(
        creator=user, zcash_address=ZADDR, linked_at_epoch=user.kt_account_epoch,
    )
    return Creator.objects.get(pk=user.pk)


def _request(client, username):
    """POST: request deletion (the 30-day grace period starts)."""
    return client.post(SCHEDULE_URL, {"confirm_username": username}, format="json")


def _delete(client, username):
    """Request deletion, then let its grace period end: the purge runs as the
    periodic task will, 30 days and a second later. Returns the request's
    response; a refused request purges nothing."""
    response = _request(client, username)
    if response.status_code == 202:
        account_deletion.purge_due_deletions(
            now=timezone.now() + account_deletion.GRACE_PERIOD
            + timezone.timedelta(seconds=1))
    return response


def test_every_relation_to_an_account_has_a_deletion_policy():
    """A new FK to the account must say what deletion does with it."""
    relations = account_deletion.account_relations()
    unclassified = relations - set(account_deletion.POLICY)
    stale = set(account_deletion.POLICY) - relations
    assert not unclassified, (
        f"classify these in account_deletion.POLICY: {sorted(unclassified)}")
    assert not stale, f"POLICY names relations that no longer exist: {sorted(stale)}"


def test_a_burner_account_deletes_completely_and_every_credential_dies(
    burner, recent_login, creator_factory,
):
    # Money first: a balance on the ledger, so "the ledger stays" is real.
    from dj.apps.tuzis import ledger

    ledger.credit(burner, Decimal("25"), source="sys:promo", ref_kind="tuzi_grant",
                  ref_id="t-1", idem=f"grant-{uuid.uuid4()}")
    account_id = ledger_api.user_account_id(burner.pk)
    assert account_id is not None

    other = creator_factory(username="neighbour")
    CreatorFollow.objects.create(creator=other, follower=burner)
    page = _page(burner)
    upload = GenericFile.objects.create(
        owner=burner, file=ContentFile(_png(), name="me.png"), mime_type="image/png",
    )
    blob = upload.file.name
    _, raw_token = AuthToken.objects.create(user=burner)
    handle = MessagingHandle.objects.get(user=burner)

    browser = APIClient()
    recent_login(browser, burner)
    token_client = APIClient()
    token_client.credentials(HTTP_AUTHORIZATION=f"Token {raw_token}")
    assert token_client.get("/api/auth/user/").status_code == 200

    preview = browser.get(URL)
    assert preview.status_code == 200, preview.content
    assert preview.json()["balance_2z"] == "25.000"
    assert preview.json()["pages"] == 1
    assert preview.json()["blockers"] == []

    response = _delete(browser, "burner_42")
    assert response.status_code == 202, response.content

    row = Creator.objects.get(pk=burner.pk)
    assert not row.is_active
    # Reserved, not released: nobody can register the name for 30 days.
    assert row.username == "burner_42" and row.deleted_at is not None
    assert (row.full_name, row.description, row.email) == ("", "", "")
    assert not row.has_usable_password()
    assert row.public_id == burner.public_id       # the ledger's key never moves
    # +1 when the deletion is requested, +1 when it is purged.
    assert row.kt_account_epoch == burner.kt_account_epoch + 2
    assert not ZcashIdentity.objects.filter(creator_id=burner.pk).exists()
    assert not AuthContext.objects.filter(creator_id=burner.pk).exists()
    assert not AuthToken.objects.filter(user_id=burner.pk).exists()
    assert not zPage.objects.filter(pk=page.pk).exists()
    assert not GenericFile.objects.filter(pk=upload.pk).exists()
    assert PendingUploadBlobDeletion.objects.filter(name=blob).exists()
    assert not CreatorFollow.objects.filter(follower_id=burner.pk).exists()
    handle.refresh_from_db()
    assert (handle.status, handle.user_id) == ("retired", None)

    # Every credential is dead: this browser, and the bearer token.
    assert browser.get("/api/auth/user/").status_code in (401, 403)
    assert token_client.get("/api/auth/user/").status_code in (401, 403)

    # The ledger row stays, pseudonymous, with its balance.
    assert ledger_api.user_account_id(burner.pk) == account_id
    assert ledger_api.read_balance(burner.pk).balance == ledger_api.to_m2z(Decimal("25"))
    # The neighbour is untouched.
    assert Creator.objects.get(pk=other.pk).is_active


def test_a_stale_sign_in_changes_nothing(burner, recent_login):
    """A real sign-in, six minutes old: past the five-minute step-up window."""
    client = APIClient()
    recent_login(client, burner)
    stale = timezone.now() - timezone.timedelta(minutes=6)
    assert AuthContext.objects.filter(creator_id=burner.pk).update(auth_time=stale) == 1
    assert client.get(URL).status_code == 200          # signed in, just not fresh
    response = _delete(client, "burner_42")
    assert response.status_code == 401
    assert response.json()["code"] == "insufficient_user_authentication"
    row = Creator.objects.get(pk=burner.pk)
    assert row.is_active and row.username == "burner_42"
    assert ZcashIdentity.objects.filter(creator_id=burner.pk).exists()


def test_the_typed_username_must_be_the_signed_in_account(
    burner, recent_login, creator_factory,
):
    """Another persona's name -- the screen showed one account, the session
    is now another -- deletes nothing."""
    creator_factory(username="other_persona")
    client = APIClient()
    recent_login(client, burner)
    response = _delete(client, "other_persona")
    assert response.status_code == 400
    assert response.json()["code"] == "confirmation_mismatch"
    assert Creator.objects.get(pk=burner.pk).is_active
    assert Creator.objects.get(username="other_persona").is_active


def test_an_app_people_use_blocks_and_nothing_changes(
    burner, recent_login, creator_factory,
):
    from dj.apps.oidc.models import AppAuthorization, F2ZApplication

    app = F2ZApplication.objects.create(
        name="Burner's app", user=burner,
        client_type=F2ZApplication.CLIENT_PUBLIC,
        redirect_uris="https://app.example.com/cb", allowed_scopes="openid",
    )
    AppAuthorization.objects.create(
        user=creator_factory(username="app_user"), application=app, scope="openid",
    )
    client = APIClient()
    recent_login(client, burner)
    assert client.get(URL).json()["blockers"] == ["app_has_users"]
    response = _delete(client, "burner_42")
    assert response.status_code == 409
    assert response.json()["code"] == "app_has_users"
    assert Creator.objects.get(pk=burner.pk).is_active
    assert F2ZApplication.objects.filter(pk=app.pk).exists()


def test_an_unused_app_is_deleted_with_the_account(burner, recent_login):
    from dj.apps.oidc.models import F2ZApplication

    app = F2ZApplication.objects.create(
        name="Never used", user=burner,
        client_type=F2ZApplication.CLIENT_PUBLIC,
        redirect_uris="https://app.example.com/cb", allowed_scopes="openid",
    )
    client = APIClient()
    recent_login(client, burner)
    assert _delete(client, "burner_42").status_code == 202
    assert not F2ZApplication.objects.filter(pk=app.pk).exists()


def test_earnings_owed_block_and_nothing_changes(
    burner, recent_login, api_client, monkeypatch,
):
    """Creator earnings survive termination; support settles them first."""
    from dj.apps.economy import contracts, services
    from dj.apps.economy.models import EconomicPolicy
    from dj.apps.economy.tests.test_api import bind, consent
    from dj.apps.economy.tests.test_foundation import activate_for_test

    monkeypatch.setattr(services, "CONTRACT_VERSION", contracts.CREATOR_CONTRACT_VERSION)
    EconomicPolicy.objects.get_or_create(pk=True)
    bind(burner)
    api_client.force_authenticate(burner)
    assert api_client.post(
        "/api/economy/agreement/accept/", consent(burner.pk), format="json",
    ).status_code == 200
    activate_for_test()
    assert account_deletion.blockers(burner) == []
    services.adjust_payable(
        creator_id=burner.pk, delta_nusd=1_000_000_000, idempotency_key="owed:deletion",
        basis={"contractual_basis": "owed", "source_reference": "source",
               "reason": "test owed"},
        operator="staff:example",
    )

    client = APIClient()
    recent_login(client, burner)
    assert client.get(URL).json()["blockers"] == ["earnings_owed"]
    response = _delete(client, "burner_42")
    assert response.status_code == 409
    assert response.json()["code"] == "earnings_owed"
    row = Creator.objects.get(pk=burner.pk)
    assert row.is_active and row.username == "burner_42"
    assert ZcashIdentity.objects.filter(creator_id=burner.pk).exists()


def test_other_peoples_replies_survive_and_own_threads_go(
    burner, recent_login, creator_factory,
):
    other = creator_factory(username="replier")
    page = _page(other)
    answered = _comment(page, burner, "answered")
    reply = _comment(page, other, "a reply", parent=answered)
    lonely = _comment(page, burner, "nobody replied")
    chain_root = _comment(page, burner, "my own chain")
    chain_reply = _comment(page, burner, "replying to myself", parent=chain_root)

    client = APIClient()
    recent_login(client, burner)
    assert _delete(client, "burner_42").status_code == 202

    answered.refresh_from_db()
    assert (answered.content, answered.headline) == ("", "")
    assert Comment.objects.filter(pk=reply.pk, content="a reply").exists()
    for gone in (lonely, chain_root, chain_reply):
        assert not Comment.objects.filter(pk=gone.pk).exists()
    assert zPage.objects.filter(pk=page.pk).exists()


def test_account_deletion_clears_replay_only_idempotency_bodies(
    burner, recent_login,
):
    """Retain paid idempotency rows, but not response content replayed to them."""
    from dj.apps.g12f.account_deletion import (
        CONTENT_REPLAY_SCOPES, CONTENT_REPLAY_SCOPE_PREFIXES,
    )

    # Audited replay producers: additions must update this inventory and the
    # deletion policy together. This list does not discover new producers.
    body_by_scope = {
        "comment": {"uuid": str(uuid.uuid4()), "content": "private comment"},
        "comment_reply": {"uuid": str(uuid.uuid4()), "content": "private reply"},
        "comment_vote": {"success": "Vote recorded", "tuzis": "1.000"},
        "page_vote": {"success": "Vote recorded", "f2z_score": "1.00000000"},
        "page_fund": {"score": "2.00000000", "replayed": False},
        "zpage-create": {"free2zaddr": "zpage-address", "etag": "etag"},
        "zpage-translate-batch": {
            "batch_id": "batch-1", "zpage_id": 19,
            "languages": ["es"], "total": 2,
        },
        "e2ee-chat-request": {
            "request_id": "request-1", "recipient": {
                "username": "burner_42", "handle": "private-handle",
            },
        },
        "storytime_page": {"page": {"content": "private generated story"}},
        "storytime_image": {"page": {"image": "private generated image"}},
        "ai_chat": {"reply": "private generated reply"},
        "ai_completion": {"value": "private generated completion"},
        "ai_prompt": {"reply": "private generated response"},
        "ai_image": {"value": "private-image-url"},
        "donate-idempotent": {"charged": "2.000", "recipient": "private-name"},
        "subscribe-confirmed": {"charged": "5.000", "expires": "2030-01-01"},
    }
    assert CONTENT_REPLAY_SCOPES == set(body_by_scope)
    scopes = sorted(body_by_scope) + [
        f"{prefix}123" for prefix in CONTENT_REPLAY_SCOPE_PREFIXES
    ]
    records = [
        IdempotencyKey.objects.create(
            scope=scope, user=burner, key=f"key-{index}",
            response_status=200,
            response_body=body_by_scope.get(
                scope, {"charged": "5.000", "expires": "2030-01-01"},
            ),
        )
        for index, scope in enumerate(scopes)
    ]

    client = APIClient()
    recent_login(client, burner)
    assert _delete(client, "burner_42").status_code == 202

    for record in records:
        record.refresh_from_db()
        expected = {"_account_deletion_scrubbed": True} if record.scope == "ai_image" else None
        assert record.response_body == expected, record.scope
        assert record.response_status == 200, record.scope
        assert IdempotencyKey.objects.filter(pk=record.pk).exists(), record.scope


def test_account_deletion_scrubs_translation_content_and_preserves_reconciliation(
    burner, recent_login,
):
    """Keep charge cursors usable while removing translated/source excerpts."""
    from dj.apps.g12f.account_deletion import (
        GRANT_RECEIPT_SCOPE, IMMUTABLE_RECONCILIATION_SCOPES,
        PURCHASE_RECOVERY_SCOPE_PREFIX,
    )

    translation = IdempotencyKey.objects.create(
        scope="zpage-translate", user=burner, key="translation-key",
        response_status=202,
        response_body={
            "job_id": "job-1", "status": "delivered", "zpage_id": 987,
            "language": "es", "source_digest": "source-digest",
            "target_digest": "target-digest", "charged": "2.000",
            "refunded": "0.000", "error": None,
            "error_detail": "private source excerpt",
            "attempted_output_preview": "private translated text",
            "_attempted_output": "private translated text",
            "_fragments": {"part": "paid translation text"},
            "warnings": [{"items": ["private source excerpt"]}],
        },
    )
    purchase_id = str(uuid.uuid4())
    purchase = IdempotencyKey.objects.create(
        scope=f"{PURCHASE_RECOVERY_SCOPE_PREFIX}first_party",
        user=burner, key="purchase-key",
        response_status=200, response_body={"purchase_id": purchase_id},
    )
    grant = IdempotencyKey.objects.create(
        scope=GRANT_RECEIPT_SCOPE, user=burner, key="grant-key", response_status=200,
        response_body={"grant_id": 42, "amount": "5.000", "balance_after": "5.000"},
    )
    note_body = {
        "note": {
            "recipient_id": burner.pk, "txid": "a" * 64, "pool": "orchard",
            "output_index": 3, "amount_zec": "0.12500000",
            "memo_plain": "original payment instruction",
        },
        "first_seen_at": timezone.now().isoformat(),
        "status": "pending_resolution",
        "reason": "purchaser_authorization_unproven",
    }
    note = IdempotencyKey.objects.create(
        scope="zec-funding-note", user=burner, key=f"{'a' * 64}:orchard:3",
        response_status=200, response_body=note_body,
    )
    note.refresh_from_db()
    note_body = note.response_body
    stripe_bodies = {
        "stripe-create-refusal": {
            "observation": {
                "checkout_id": "checkout-1", "code": "parameter_invalid_empty",
                "parameter": "line_items", "provider_request_id": "req_1",
                "observed_at": timezone.now().isoformat(),
            },
            "cleanup_status": "released",
        },
        "stripe-authorization-terminal": {
            "observation": {
                "provider_event_id": "evt_auth", "payment_intent_id": "pi_1",
                "session_id": "cs_1", "status": "canceled",
                "amount_received": 0, "observed_at": timezone.now().isoformat(),
            },
            "status": "cancelled",
        },
        "stripe-session-terminal": {
            "status": "expired_without_capture", "session_id": "cs_2",
            "payment_intent_id": "pi_2", "observed_at": timezone.now().isoformat(),
        },
        "stripe-financial-event": {
            "status": "pending_resolution",
            "observation": {
                "provider_event_id": "evt_fin", "event_type": "charge.refunded",
                "charge_id": "ch_1", "payment_intent_id": "pi_3",
                "refund_succeeded_cents": 50, "captured_cents": 100,
                "dispute_id": None, "dispute_status": None,
                "dispute_balance_transactions": None,
            },
        },
        "stripe-financial-evidence": {
            "snapshot": {
                "signed_event": {"id": "evt_fin", "type": "charge.refunded"},
                "provider_snapshot": {
                    "charge_id": "ch_1", "payment_intent_id": "pi_3",
                    "captured_cents": 100, "refund_succeeded_cents": 50,
                },
                "plan": {"target_m2z": "500", "issued_m2z": "1000"},
            },
            "outcomes": [{
                "outcome_id": "outcome-digest", "status": "reconciled",
                "reason": "verified_provider_movement_applied",
                "ledger_operation": {"idempotency_key": "financial-event-key"},
            }],
        },
        "stripe-financial-state": {
            "latest_event_created": 1792195200,
            "snapshot_read_started_at": timezone.now().isoformat(),
            "snapshot_fingerprint": "snapshot-digest", "provider_event_id": "evt_fin",
            "ledger_operation": {"idempotency_key": "financial-event-key"},
            "applied_plan": {
                "target_m2z": "500", "issued_m2z": "1000", "captured_cents": 100,
                "refund_completed_cents": 50, "dispute_outstanding_cents": 0,
                "refund_statuses": [{"id": "re_1", "status": "succeeded", "amount": 50}],
                "refund_balance_transactions": [{"refund_id": "re_1", "refund_amount_cents": 50}],
                "dispute_movement_ids": [],
            },
        },
    }
    assert IMMUTABLE_RECONCILIATION_SCOPES == {
        "zec-funding-note", *stripe_bodies,
    }
    stripe_records = [
        IdempotencyKey.objects.create(
            scope=scope, user=burner, key=f"event-{index}",
            request_hash=f"event-digest-{index}", response_status=200, response_body=body,
        )
        for index, (scope, body) in enumerate(stripe_bodies.items())
    ]

    client = APIClient()
    recent_login(client, burner)
    assert _delete(client, "burner_42").status_code == 202

    translation.refresh_from_db()
    assert translation.response_body["job_id"] == "job-1"
    assert translation.response_body["zpage_id"] == 987
    assert translation.response_body["language"] == "es"
    assert translation.response_body["source_digest"] == "source-digest"
    assert translation.response_body["charged"] == "2.000"
    for personal_field in (
        "error_detail", "attempted_output_preview", "_attempted_output",
        "_fragments", "warnings",
    ):
        assert personal_field not in translation.response_body

    # These references are consumed by stale-checkout recovery, the grant
    # audit receipt, and captured-note/Stripe reconciliation. In particular,
    # the DB guard makes the historical ZEC note identity immutable.
    purchase.refresh_from_db()
    assert purchase.response_body == {"purchase_id": purchase_id}
    grant.refresh_from_db()
    assert grant.response_body["grant_id"] == 42
    note.refresh_from_db()
    assert note.response_body == note_body
    for record in stripe_records:
        identity = (record.key, record.owner, record.request_hash, record.response_status)
        record.refresh_from_db()
        assert record.response_body == stripe_bodies[record.scope]
        assert (record.key, record.owner, record.request_hash, record.response_status) == identity

    # Retained applied state is operational proof: a failed refund can restore
    # funds only when it matches the earlier successful refund and cursor.
    from dj.apps.ztripe.economic_events import _restoration_is_proven

    state = next(record for record in stripe_records if record.scope == "stripe-financial-state")
    reversal = {
        **state.response_body["applied_plan"], "target_m2z": "0",
        "refund_completed_cents": 0, "refund_balance_transactions": [],
        "refund_statuses": [{
            "id": "re_1", "status": "failed", "amount": 50,
            "failure_movement_id": "txn_refund_return",
        }],
    }
    cursor = SimpleNamespace(refunded_m2z=500)
    assert _restoration_is_proven(state.response_body, reversal, cursor, 0)
    assert not _restoration_is_proven({}, reversal, cursor, 0)


def test_account_deletion_preserves_bodyless_scoring_completion(burner, recent_login):
    from dj.apps.g12f.account_deletion import BODYLESS_COMPLETION_SCOPES
    from dj.apps.tuzis import models as idempotency

    assert BODYLESS_COMPLETION_SCOPES == {"aiscore_comment"}
    key = str(uuid.uuid4())
    record = idempotency.claim("aiscore_comment", burner, key)
    record.finish(status=200)
    owner = record.owner

    client = APIClient()
    recent_login(client, burner)
    assert _delete(client, "burner_42").status_code == 202

    record.refresh_from_db()
    assert record.response_body is None
    assert record.response_status == 200
    assert record.owner == owner
    # A delayed duplicate delivery must see completion, not claim another
    # scoring reward/penalty after the author's content has been purged.
    with pytest.raises(idempotency.DuplicateRequest) as duplicate:
        idempotency.claim("aiscore_comment", burner, key)
    assert duplicate.value.record.pk == record.pk


def test_late_translation_writers_keep_settlement_and_do_not_restore_content(
    burner, recent_login, creator_factory,
):
    from dj.apps.g12f.translation import charges

    queued_body = {
        "job_id": "late-job", "status": "queued", "zpage_id": 19,
        "language": "es", "source_digest": "source-digest",
        "charged": "2.000", "refunded": "0.000", "balance": "0.000",
        "_fragments": {"secret": "private translation"},
    }
    stashed = IdempotencyKey.objects.create(
        scope=charges.SCOPE, user=burner, key="late-stash",
        response_status=202, response_body=dict(queued_body),
    )
    failed = IdempotencyKey.objects.create(
        scope=charges.SCOPE, user=burner, key="late-failure",
        response_status=202, response_body={**queued_body, "job_id": "late-failure"},
    )
    delivered = IdempotencyKey.objects.create(
        scope=charges.SCOPE, user=burner, key="late-delivery",
        response_status=202, response_body={**queued_body, "job_id": "late-delivery"},
    )
    other = creator_factory(username="other-translation-owner")
    other_record = IdempotencyKey.objects.create(
        scope=charges.SCOPE, user=other, key="other-owner",
        response_status=202,
        response_body={**queued_body, "job_id": "other-owner", "_fragments": {
            "secret": "keep other account's content",
        }},
    )

    client = APIClient()
    recent_login(client, burner)
    assert _delete(client, "burner_42").status_code == 202

    assert charges.stash_contended_run(
        stashed.pk,
        SimpleNamespace(
            calls=2, input_tokens=30, output_tokens=40,
            carried={}, fragments={"late": "private retry fragment"},
        ),
    ) is True
    stashed.refresh_from_db()
    assert stashed.response_body["_account_deletion_scrubbed"] is True
    assert stashed.response_body["_contended_spend"]["calls"] == 2
    assert "_fragments" not in stashed.response_body

    assert charges.settle_failure(
        failed.pk, code="provider_error", detail="private failure excerpt",
        attempted_output="private generated output",
    ) is True
    failed.refresh_from_db()
    assert failed.response_body["status"] == charges.REFUNDED
    assert failed.response_body["charged"] == "2.000"
    assert failed.response_body["refunded"] == "2.000"
    assert failed.response_body["_account_deletion_scrubbed"] is True
    assert not ({"error_detail", "_attempted_output", "_fragments"}
                & failed.response_body.keys())

    assert charges.mark_delivered(
        delivered.pk,
        warnings=[{"code": "private", "items": ["private article excerpt"]}],
        draft_digest="draft-digest",
    ) is not None
    delivered.refresh_from_db()
    assert delivered.response_body["status"] == charges.DELIVERED
    assert delivered.response_body["draft_digest"] == "draft-digest"
    assert "warnings" not in delivered.response_body
    assert delivered.response_body["_account_deletion_scrubbed"] is True

    other_record.refresh_from_db()
    assert other_record.response_body["_fragments"] == {
        "secret": "keep other account's content",
    }
    assert "_account_deletion_scrubbed" not in other_record.response_body


@pytest.mark.django_db(transaction=True)
def test_atomic_translation_scrub_preserves_a_concurrent_settlement(
    creator_factory,
):
    """A row-locked writer commits first; JSONB subtraction uses its new body."""
    creator = creator_factory(username="scrub-race")
    record = IdempotencyKey.objects.create(
        scope="zpage-translate", user=creator, key="scrub-race",
        response_status=202,
        response_body={
            "job_id": "scrub-race", "status": "queued", "charged": "3.000",
            "refunded": "0.000", "error_detail": "private text",
            "_fragments": {"chunk": "private translation"},
        },
    )
    writer_has_row_lock = threading.Event()
    allow_writer_commit = threading.Event()
    scrub_backend_pid = Queue()

    def settle_like_worker():
        connections.close_all()
        try:
            with transaction.atomic():
                row = IdempotencyKey.objects.select_for_update().get(pk=record.pk)
                body = dict(row.response_body)
                writer_has_row_lock.set()
                if not allow_writer_commit.wait(timeout=8):
                    raise TimeoutError("scrub test writer was not released")
                body.update(status="refunded", refunded="3.000", billed="0.000")
                IdempotencyKey.objects.filter(pk=row.pk).update(response_body=body)
        finally:
            connections.close_all()

    def scrub_account_content():
        connections.close_all()
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT pg_backend_pid()")
                scrub_backend_pid.put(cursor.fetchone()[0])
            account_deletion._scrub_idempotency_response_bodies(
                creator, account_deletion.DeletionReport(),
            )
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        writer = pool.submit(settle_like_worker)
        assert writer_has_row_lock.wait(timeout=5)
        scrubber = pool.submit(scrub_account_content)
        pid = scrub_backend_pid.get(timeout=5)
        deadline = time.monotonic() + 5
        is_waiting_for_row = False
        while time.monotonic() < deadline:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT wait_event_type = 'Lock' FROM pg_stat_activity "
                    "WHERE pid = %s",
                    [pid],
                )
                row = cursor.fetchone()
            if row and row[0]:
                is_waiting_for_row = True
                break
            time.sleep(0.01)
        allow_writer_commit.set()
        assert is_waiting_for_row, "scrub did not contend with the row-locked writer"
        writer.result(timeout=5)
        scrubber.result(timeout=5)

    record.refresh_from_db()
    assert record.response_body["status"] == "refunded"
    assert record.response_body["refunded"] == "3.000"
    assert record.response_body["billed"] == "0.000"
    assert record.response_body["_account_deletion_scrubbed"] is True
    assert "error_detail" not in record.response_body
    assert "_fragments" not in record.response_body


def test_deleting_one_persona_leaves_its_siblings_signed_in(
    burner, recent_login, creator_factory, monkeypatch,
):
    """Personas are separate accounts: deleting one must not touch the
    other's credentials or sessions."""
    from dj.apps.emails.models import Email

    sibling = creator_factory(username="sibling", password="sibling-pass-123")
    Email.objects.create(user=sibling, email="sibling@example.com", token="t" * 32,
                         expires_at=timezone.now(), confirmed_at=timezone.now())
    ZcashIdentity.objects.create(
        creator=sibling, zcash_address="t1SiblingAddressxxxxxxxxxxxxxxxxxx",
        linked_at_epoch=sibling.kt_account_epoch,
    )
    sibling_client = APIClient()
    recent_login(sibling_client, sibling)
    client = APIClient()
    recent_login(client, burner)
    assert _delete(client, "burner_42").status_code == 202

    assert sibling_client.get("/api/auth/user/").status_code == 200
    row = Creator.objects.get(pk=sibling.pk)
    assert row.kt_account_epoch == sibling.kt_account_epoch
    assert row.is_active and row.has_usable_password()
    assert Email.objects.filter(user=sibling, email="sibling@example.com").exists()
    assert ZcashIdentity.objects.filter(creator=sibling).exists()
    # Recovery still works: a fresh password sign-in (captcha stubbed at the
    # provider boundary, as the login tests do).
    from types import SimpleNamespace

    monkeypatch.setattr(
        "dj.apps.g12f.captcha.requests.post",
        lambda _url, **_kw: SimpleNamespace(json=lambda: {"success": True}),
    )
    from django.core.cache import cache

    cache.clear()
    fresh = APIClient()
    assert fresh.post("/api/auth/login/", {
        "username": "sibling", "password": "sibling-pass-123",
        "captcha_result": "ci-valid-captcha",
    }, format="json").status_code in (200, 204)
    assert fresh.get("/api/auth/user/").json()["username"] == "sibling"


def test_an_anonymous_caller_is_refused(api_client):
    assert api_client.get(URL).status_code in (401, 403)
    assert api_client.post(SCHEDULE_URL, {"confirm_username": "x"}, format="json").status_code in (401, 403)


# --- codex adversarial review findings, each pinned ------------------------


def test_an_ownership_event_that_lands_first_stops_the_deletion(burner):
    """A password reset (or any ownership event) committed while a deletion
    waited for the row lock evicts the credential that asked. The deletion
    must not then proceed on the recovered account."""
    from dj.apps.ktauth.epoch import EVENT_PASSWORD_RESET, bump_account_epoch

    proved_under = burner.kt_account_epoch
    bump_account_epoch(burner.pk, event=EVENT_PASSWORD_RESET)
    with pytest.raises(account_deletion.DeletionBlocked) as refused:
        account_deletion.delete_account(
            burner, confirm_username="burner_42", auth_epoch=proved_under)
    assert refused.value.code == account_deletion.REAUTHENTICATE
    row = Creator.objects.get(pk=burner.pk)
    assert row.is_active and row.username == "burner_42"
    assert ZcashIdentity.objects.filter(creator_id=burner.pk).exists()


def test_paid_work_not_yet_settled_blocks(burner, monkeypatch):
    """A viewer admitted to a paid livestream settles on a later webhook --
    after a deletion, into earnings nobody could claim."""
    from dj.apps.economy import contracts, services
    from dj.apps.economy.tests.test_foundation import activate_for_test, make_contract

    monkeypatch.setattr(services, "CONTRACT_VERSION", contracts.CREATOR_CONTRACT_VERSION)
    activate_for_test()
    _, _, _, admission = make_contract(burner)
    assert account_deletion.blockers(burner) == ["earnings_owed"]

    # Still blocked after the stream ends, while a reconnect's or a late
    # departure's settlement may still arrive...
    from dj.apps.dyte.models import CreatorMeeting

    CreatorMeeting.objects.filter(creator=burner).update(live_now=False)
    inside = admission.admitted_at + account_deletion.SETTLEMENT_WINDOW - timezone.timedelta(minutes=1)
    assert account_deletion.blockers(burner, now=inside) == ["earnings_owed"]
    #... but an abandoned join (admitted, never delivered) does not block
    # forever: past the window, with nothing owed, the account may go.
    after = admission.admitted_at + account_deletion.SETTLEMENT_WINDOW + timezone.timedelta(minutes=1)
    assert account_deletion.blockers(burner, now=after) == []


def test_search_vectors_of_deleted_pages_go_too(burner, recent_login):
    from django.contrib.contenttypes.models import ContentType
    from dj.apps.search.models import SearchIndex

    page = _page(burner)
    SearchIndex.objects.create(
        content_type=ContentType.objects.get_for_model(zPage),
        object_id=page.pk, vector=[0.0] * 1536,
    )
    client = APIClient()
    recent_login(client, burner)
    assert _delete(client, "burner_42").status_code == 202
    assert not SearchIndex.objects.filter(object_id=page.pk).exists()


def test_pending_recordings_and_announcements_are_cut_loose(burner, recent_login):
    from dj.apps.dyte.models import RecordingDelivery
    from dj.apps.twitter.models import Announcement

    delivery = RecordingDelivery.objects.create(
        idempotency_key=uuid.uuid4(), creator=burner,
        download_url="https://provider.example/recording.mp4",
    )
    pending = Announcement.objects.create(
        event_key=f"zpage:first-published:{uuid.uuid4()}",
        kind=Announcement.ZPAGE_FIRST_PUBLISHED, subject_user=burner,
        text="burner_42 published My page", url="https://free2z.cash/burner_42/p",
    )
    client = APIClient()
    recent_login(client, burner)
    assert _delete(client, "burner_42").status_code == 202

    delivery.refresh_from_db()
    assert delivery.creator_id is None       # the retry terminalizes
    pending.refresh_from_db()
    assert pending.status == Announcement.SUPPRESSED
    assert (pending.text, pending.url, pending.subject_user_id) == ("", "", None)


def test_content_under_an_open_report_is_held_not_erased(
    burner, recent_login, creator_factory,
):
    """The author must not be able to destroy what a report is about."""
    from dj.apps.comments.models import ContentReport

    reporter = creator_factory(username="reporter")
    reported = _page(burner)
    unreported = _page(burner)
    upload = GenericFile.objects.create(
        owner=burner, file=ContentFile(_png(), name="evidence.png"), mime_type="image/png",
    )
    ContentReport.objects.create(
        reporter=reporter, target_kind="zpage", target_id=reported.free2zaddr,
        reason=ContentReport.Reason.CSAE,
    )
    client = APIClient()
    recent_login(client, burner)
    assert _delete(client, "burner_42").status_code == 202

    assert zPage.objects.filter(pk=reported.pk).exists()
    assert not zPage.objects.filter(pk=unreported.pk).exists()
    assert GenericFile.objects.filter(pk=upload.pk).exists()
    assert not Creator.objects.get(pk=burner.pk).is_active
    assert ContentReport.objects.get(target_id=reported.free2zaddr).reporter_id == reporter.pk


def test_a_report_against_the_account_keeps_its_profile_and_content(
    burner, recent_login, creator_factory,
):
    from dj.apps.comments.models import ContentReport

    page = _page(burner)
    ContentReport.objects.create(
        reporter=creator_factory(username="reporter2"), target_kind="creator",
        target_id=str(burner.pk), reason=ContentReport.Reason.HARASSMENT,
    )
    client = APIClient()
    recent_login(client, burner)
    assert _delete(client, "burner_42").status_code == 202

    row = Creator.objects.get(pk=burner.pk)
    assert (row.username, row.full_name, row.is_active) == ("burner_42", "Real Name", False)
    assert not row.has_usable_password()
    assert not ZcashIdentity.objects.filter(creator_id=burner.pk).exists()
    assert zPage.objects.filter(pk=page.pk).exists()


# --- the policy is applied, not just declared ------------------------------

#Enforced relations the kitchen-sink test below does not seed, and why.
#Anything else enforced must be seeded, so a new DELETE/UNLINK/REVOKE entry
#with no code behind it turns this suite red.
NOT_SEEDED = {
    "oidc.DeviceGrant.user": "no device flow is offered; the row type exists only in the library",
}


def _seed_every_enforced_relation(user, other, ai_model):
    """One row per DELETE / UNLINK / REVOKE relation, pointing at ``user``."""
    import secrets as _secrets

    from django.contrib.auth.models import Group, Permission

    from dj.apps.comments.models import ContentReport
    from dj.apps.dyte.models import (
        ProviderRoomCleanup, RecordingDelivery, RecordingDeliveryTarget,
    )
    from dj.apps.e2ee.models import ChatRequest
    from dj.apps.emails.models import Email
    from dj.apps.exports.models import PublicationExportJob
    from dj.apps.g12f.models import (
        CreatorBlock, CreatorMute, PageMentionDelivery, Series,
    )
    from dj.apps.identity.models import RecoveryCode, WebAuthnCredential
    from dj.apps.oidc.models import (
        AccessToken, AppAuthorization, AuthorizationCode, F2ZApplication,
        IDToken, RefreshToken,
    )
    from dj.apps.openai.models import Conversation, Personality, PromptResponse
    from dj.apps.otp.models import OTPSecret
    from dj.apps.social.models import SocialIdentity
    from dj.apps.storytime.models import Story
    from dj.apps.tagging.models import TagSuggestion
    from dj.apps.twitter.models import Announcement, TwitterProfile

    now = timezone.now()
    later = now + timezone.timedelta(hours=1)
    epoch = user.kt_account_epoch
    Email.objects.create(user=user, email="burner@example.com", token="e" * 32, expires_at=later)
    OTPSecret.objects.create(user=user, secret="JBSWY3DPEHPK3PXP")
    WebAuthnCredential.objects.create(
        creator=user, credential_id=b"c" * 32, public_key=b"key", rp_id="free2z.cash",
        linked_at_epoch=epoch)
    RecoveryCode.objects.create(creator=user, digest="d" * 64, issued_at_epoch=epoch)
    SocialIdentity.objects.create(creator=user, provider="google", provider_uid="g-burner",
                                  linked_at_epoch=epoch)
    TwitterProfile.objects.create(creator=user, twitter_id="99", username="burnerx")
    AuthToken.objects.create(user=user)
    user.groups.add(Group.objects.create(name=f"g-{uuid.uuid4().hex[:8]}"))
    user.user_permissions.add(Permission.objects.first())

    app = F2ZApplication.objects.create(
        name="Someone's app", user=other, client_type=F2ZApplication.CLIENT_PUBLIC,
        redirect_uris="https://app.example.com/cb", allowed_scopes="openid")
    AppAuthorization.objects.create(user=user, application=app, scope="openid")
    AuthorizationCode.objects.create(
        user=user, application=app, code=_secrets.token_hex(16), expires=later,
        redirect_uri="https://app.example.com/cb", account_epoch=epoch)
    id_token = IDToken.objects.create(user=user, application=app, expires=later)
    AccessToken.objects.create(
        user=user, application=app, token=_secrets.token_hex(16), expires=later,
        account_epoch=epoch, grant_generation=1, id_token=id_token)
    RefreshToken.objects.create(
        user=user, application=app, token=_secrets.token_hex(16),
        account_epoch=epoch, token_family=uuid.uuid4())

    CreatorFollow.objects.create(creator=other, follower=user)
    CreatorFollow.objects.create(creator=user, follower=other)
    CreatorBlock.objects.create(blocker=user, blocked=other)
    CreatorBlock.objects.create(blocker=other, blocked=user)
    CreatorMute.objects.create(muter=user, muted=other)
    CreatorMute.objects.create(muter=other, muted=user)
    PageMentionDelivery.objects.create(author=user, recipient=other, status="sent")
    PageMentionDelivery.objects.create(author=other, recipient=user, status="sent")

    page = _page(user)
    Series.objects.create(name="Mine", creator=user)
    GenericFile.objects.create(owner=user, file=ContentFile(_png(), name="k.png"),
                               mime_type="image/png")
    others_page = _page(other)
    _comment(others_page, user, "hello")
    ContentReport.objects.create(reporter=user, target_kind="zpage",
                                 target_id=others_page.free2zaddr, reason="spam",
                                 status="resolved")
    Conversation.objects.create(ai_model=ai_model, user=user, display_name="chat")
    PromptResponse.objects.create(user=user, user_input="q", response="a")
    Personality.objects.create(creator=user, display_name="p", system_message="s")
    Story.objects.create(creator=user, title="t", slug=f"s-{uuid.uuid4().hex[:8]}")
    ChatRequest.objects.create(sender=user, recipient=other, sender_handle="burner_42",
                               charged=Decimal("0"))
    ChatRequest.objects.create(sender=other, recipient=user, sender_handle="neighbour",
                               charged=Decimal("0"))
    PublicationExportJob.objects.create(creator=user)
    TagSuggestion.objects.create(zpage=others_page, name="tag", name_key="tag",
                                 decided_by=user)
    from dj.apps.oidc.models import AiOutputReport

    AiOutputReport.objects.create(application=app, reporter=user, call_id=uuid.uuid4(),
                                  reason="incorrect")
    AiOutputReport.objects.create(application=app, reporter=user, call_id=uuid.uuid4(),
                                  reason="other", detail="my own words", status="resolved")
    AiOutputReport.objects.create(application=app, reporter=user, call_id=uuid.uuid4(),
                                  reason="unsafe", detail="still under review", status="open")
    from dj.apps.oidc.models import AudienceChange

    AudienceChange.objects.create(application=app, previous=False, child_directed=True,
                                  changed_by=user, via="console")
    Announcement.objects.create(event_key=f"zpage:first-published:{page.pk}",
                                kind=Announcement.ZPAGE_FIRST_PUBLISHED, subject_user=user)
    ProviderRoomCleanup.objects.create(creator=user, provider_meeting_id="m-1")
    RecordingDelivery.objects.create(idempotency_key=uuid.uuid4(), creator=user)
    RecordingDeliveryTarget.objects.create(creator=user, provider_meeting_id="m-2",
                                           meeting_type="private", is_public=False)


def _rows(name, pk):
    model, field_name = account_deletion._relation(name)
    return model._base_manager.filter(**{field_name: pk})


def test_every_enforced_policy_entry_is_carried_out(
    burner, recent_login, creator_factory,
):
    """Seed a row for every DELETE / UNLINK / REVOKE relation, delete, and
    check each one's rows were actually removed, unlinked or revoked."""
    from dj.apps.openai.models import AIModel

    other = creator_factory(username="neighbour")
    ai_model = AIModel.objects.create(model="gpt-test", display_name="Test Model",
                                      system_message="be helpful", max_tokens=4096,
                                      is_ga=True)
    client = APIClient()
    recent_login(client, burner)
    _seed_every_enforced_relation(burner, other, ai_model)

    enforced = {name for name, (action, _) in account_deletion.POLICY.items()
                if action in (account_deletion.DELETE, account_deletion.UNLINK,
                              account_deletion.REVOKE)}
    seeded = {name for name in enforced if _rows(name, burner.pk).exists()}
    assert enforced - seeded == set(NOT_SEEDED), (
        f"seed these or justify them in NOT_SEEDED: {sorted(enforced - seeded - set(NOT_SEEDED))}")
    assert account_deletion.policy_violations(burner.pk), "the seed proves nothing"

    assert _delete(client, "burner_42").status_code == 202
    assert account_deletion.policy_violations(burner.pk) == []
    from dj.apps.oidc.models import AiOutputReport
    assert not AiOutputReport.objects.filter(detail="my own words").exists()
    assert AiOutputReport.objects.filter(detail="still under review", reporter=None).exists()
    from dj.apps.oidc.models import AudienceChange
    assert AudienceChange.objects.filter(child_directed=True, changed_by=None).exists(), \
        "the audit row stays; only who changed it is unlinked"
    # Rows by name, so a regression names the relation it broke.
    for name in sorted(seeded):
        action = account_deletion.POLICY[name][0]
        rows = _rows(name, burner.pk)
        if name == "oidc.AppAuthorization.user":
            assert not rows.filter(revoked_at__isnull=True).exists(), name
        elif name == "oidc.RefreshToken.user":
            assert not rows.filter(revoked__isnull=True).exists(), name
        else:
            assert not rows.exists(), (name, action)


def test_a_policy_with_no_code_behind_it_rolls_the_deletion_back(
    burner, recent_login, monkeypatch,
):
    """Fail closed: a step that silently does nothing aborts the deletion."""
    from dj.apps.twitter.models import Announcement

    Announcement.objects.create(event_key=f"x:{uuid.uuid4()}",
                                kind=Announcement.ZPAGE_FIRST_PUBLISHED, subject_user=burner)
    monkeypatch.setattr(account_deletion, "_unlink_records", lambda creator, report: None)
    with pytest.raises(account_deletion.PolicyNotApplied):
        account_deletion.delete_account(
            burner, confirm_username="burner_42", auth_epoch=burner.kt_account_epoch)
    row = Creator.objects.get(pk=burner.pk)
    assert row.is_active and row.deleted_at is None
    assert ZcashIdentity.objects.filter(creator_id=burner.pk).exists()


# --- the 30-day username reservation ---------------------------------------


def test_the_username_is_reserved_then_released(burner, recent_login, creator_factory):
    from dj.apps.tuzis.models import TuziGrant

    client = APIClient()
    recent_login(client, burner)
    assert _delete(client, "burner_42").status_code == 202
    deleted_at = Creator.objects.get(pk=burner.pk).deleted_at

    # Reserved: the name cannot be registered while the row holds it.
    assert Creator.objects.filter(username__iexact="BURNER_42").count() == 1
    assert account_deletion.release_deleted_usernames(
        now=deleted_at + account_deletion.USERNAME_RESERVATION - timezone.timedelta(minutes=1),
    ) == 0
    assert Creator.objects.get(pk=burner.pk).username == "burner_42"

    grant_ids = list(TuziGrant.objects.filter(creator_id=burner.pk).values_list("pk", flat=True))
    assert account_deletion.release_deleted_usernames(
        now=deleted_at + account_deletion.USERNAME_RESERVATION,
    ) == 1
    row = Creator.objects.get(pk=burner.pk)
    assert row.username.startswith("deleted_") and row.username_ci_legacy is None
    assert row.username_released_at is not None
    assert account_deletion.release_deleted_usernames(
        now=deleted_at + 2 * account_deletion.USERNAME_RESERVATION) == 0   # idempotent
    assert not TuziGrant.objects.filter(pk__in=grant_ids, username="burner_42").exists()
    # Released: someone else may now take the name.
    creator_factory(username="burner_42")


def test_a_live_or_reported_account_keeps_its_name(burner, creator_factory):
    from dj.apps.comments.models import ContentReport

    live = creator_factory(username="still_here")
    Creator.objects.filter(pk=live.pk).update(
        deleted_at=timezone.now() - timezone.timedelta(days=90))
    Creator.objects.filter(pk=burner.pk).update(
        is_active=False, deleted_at=timezone.now() - timezone.timedelta(days=90))
    ContentReport.objects.create(reporter=live, target_kind="creator",
                                 target_id=str(burner.pk), reason="harassment")
    assert account_deletion.release_deleted_usernames() == 0
    assert Creator.objects.get(pk=burner.pk).username == "burner_42"
    assert Creator.objects.get(pk=live.pk).username == "still_here"


# --- review rulings --------------------------------------------------------


def test_a_staff_account_cannot_delete_itself(burner, recent_login):
    Creator.objects.filter(pk=burner.pk).update(is_staff=True)
    client = APIClient()
    recent_login(client, burner)
    assert client.get(URL).json()["blockers"] == ["staff_account"]
    response = _delete(client, "burner_42")
    assert response.status_code == 409
    assert response.json()["code"] == "staff_account"
    assert Creator.objects.get(pk=burner.pk).is_active


def test_an_x_only_account_can_delete_itself(creator_factory, api_client):
    """The 137 accounts whose only credential is an X identity  must be
    able to delete: a fresh X sign-in is their step-up."""
    from types import SimpleNamespace

    from django.conf import settings

    from dj.apps.identity.auth_context import federated, record_login
    from dj.apps.twitter.models import TwitterProfile

    user = creator_factory(username="x_only")
    user.set_unusable_password()
    user.save()
    TwitterProfile.objects.create(creator=user, twitter_id="1979", username="x_only")
    api_client.force_login(user)
    session = api_client.session
    record_login(SimpleNamespace(session=session), user, methods=[federated("twitter")])
    api_client.cookies[settings.SESSION_COOKIE_NAME] = session.session_key

    assert _delete(api_client, "x_only").status_code == 202
    assert not TwitterProfile.objects.filter(creator_id=user.pk).exists()
    assert not Creator.objects.get(pk=user.pk).is_active


def test_a_held_comment_leaves_public_view_and_a_banned_one_is_still_erased(
    burner, recent_login, creator_factory,
):
    from dj.apps.comments.models import ContentReport

    other = creator_factory(username="page_owner")
    page = _page(other)
    reported = _comment(page, burner, "reported text")
    banned = _comment(page, burner, "banned text")
    Comment._base_manager.filter(pk=banned.pk).update(is_banned=True)
    ContentReport.objects.create(reporter=other, target_kind="comment",
                                 target_id=str(reported.pk), reason="harassment")
    client = APIClient()
    recent_login(client, burner)
    assert _delete(client, "burner_42").status_code == 202

    held = Comment._base_manager.get(pk=reported.pk)
    assert held.content == "reported text" and held.is_banned
    assert not Comment.objects.filter(pk=reported.pk).exists()   # out of public view
    assert not Comment._base_manager.filter(pk=banned.pk).exists()


def test_a_name_that_merely_starts_with_deleted_is_still_released(creator_factory):
    """``deleted_`` is a prefix anyone may register; release is tracked."""
    user = creator_factory(username="deleted_alice")
    Creator.objects.filter(pk=user.pk).update(
        is_active=False, deleted_at=timezone.now() - timezone.timedelta(days=31))
    assert account_deletion.release_deleted_usernames() == 1
    row = Creator.objects.get(pk=user.pk)
    assert row.username != "deleted_alice" and row.username_released_at is not None


def test_an_app_authorized_after_the_blocker_check_is_not_deleted(
    burner, creator_factory, monkeypatch,
):
    """``blockers()`` reads before the app row is locked; a first consent can
    commit in between. The grant must survive and the deletion must refuse."""
    from dj.apps.oidc.models import AppAuthorization, F2ZApplication

    app = F2ZApplication.objects.create(
        name="Just authorized", user=burner, client_type=F2ZApplication.CLIENT_PUBLIC,
        redirect_uris="https://app.example.com/cb", allowed_scopes="openid")
    grant = AppAuthorization.objects.create(
        user=creator_factory(username="first_user"), application=app, scope="openid")
    # The interleaving: the blocker check ran before the grant committed.
    monkeypatch.setattr(account_deletion, "blockers", lambda creator, **kw: [])
    with pytest.raises(account_deletion.DeletionBlocked) as refused:
        account_deletion.delete_account(
            burner, confirm_username="burner_42", auth_epoch=burner.kt_account_epoch)
    assert refused.value.code == account_deletion.BLOCKER_APP_HAS_USERS
    assert AppAuthorization.objects.filter(pk=grant.pk).exists()
    assert F2ZApplication.objects.filter(pk=app.pk).exists()
    assert Creator.objects.get(pk=burner.pk).is_active


@pytest.mark.parametrize("delete_first", [False, True])
@pytest.mark.parametrize("already_billed", [False, True])
def test_image_accounting_survives_deletion_without_late_content_restore(
    burner, recent_login, creator_factory, tmp_path, delete_first, already_billed,
):
    """Both completion orders retain spend and reconcile without private content."""
    import json
    from django.core.management import call_command
    from dj.apps.openai import hosted_image, views

    receipt = IdempotencyKey.objects.create(
        scope="ai_image", user=burner, key="deleted-fal-image", request_hash="a" * 64,
        response_body={"prompt": "private prompt", "value": "https://private.example/image"},
    )
    assert views._reserve_hosted_image_budget(receipt, Decimal("0.006"), Decimal("0.006"))
    original = dict(receipt.response_body)
    metadata = {
        "provider": "fal", "model": hosted_image.MODEL,
        "model_version": hosted_image.MODEL_VERSION,
        "request_id": "deleted-fal-request", "estimated_usd": "0.006",
        "billed_usd": None, "billing_state": "unknown", "budget_state": "uncertain",
        "result": {"url": "https://private.example/provider-output"},
    }

    if already_billed:
        metadata.update(billed_usd="0.004", billing_state="reconciled",
            budget_state="billed", budget_reserved_usd="0.004")

    def complete():
        receipt.response_body = dict(original)
        views._record_hosted_image_request(receipt, metadata)
        operation = {**original["_image_operation"], **metadata}
        receipt.finish(503, {
            "prompt": "private prompt", "value": "https://private.example/image",
            "_image_operation": operation,
        })

    if not delete_first:
        complete()
    client = APIClient()
    recent_login(client, burner)
    assert _delete(client, "burner_42").status_code == 202
    if delete_first:
        complete()

    receipt.refresh_from_db()
    assert receipt.response_body["_account_deletion_scrubbed"] is True
    assert receipt.request_hash is None
    assert "private" not in json.dumps(receipt.response_body)
    assert set(receipt.response_body) == {"_account_deletion_scrubbed", "_image_operation"}
    operation = receipt.response_body["_image_operation"]
    assert operation["request_id"] == "deleted-fal-request"
    assert operation["budget_reserved_usd"] == ("0.004" if already_billed else "0.006")
    assert operation["billed_usd"] == ("0.004" if already_billed else None)
    other = IdempotencyKey.objects.create(scope="ai_image", user=creator_factory(), key="next-image")
    assert not views._reserve_hosted_image_budget(other, Decimal("0.006"), Decimal("0.006"))

    source = tmp_path / "deleted-image-billing.jsonl"
    source.write_text(json.dumps({
        "request_id": "deleted-fal-request", "actual_usd": "0.0055",
        "record_ref": "billing-row-1",
    }) + "\n")
    if already_billed:
        from django.core.management.base import CommandError
        with pytest.raises(CommandError, match="not eligible for cost reconciliation"):
            call_command("reconcile_image_provider_costs", str(source))
    else:
        call_command("reconcile_image_provider_costs", str(source))
    receipt.refresh_from_db()
    assert "private" not in json.dumps(receipt.response_body)
    assert receipt.response_body["_account_deletion_scrubbed"] is True
    assert receipt.request_hash is None
    operation = receipt.response_body["_image_operation"]
    assert operation["billing_state"] == "reconciled"
    assert operation["billed_usd"] == ("0.004" if already_billed else "0.0055")
    if not already_billed:
        assert operation["billing_evidence"]["record_ref"] == "billing-row-1"


@pytest.mark.django_db
def test_deleted_headerless_openai_image_receipt_keeps_only_private_key_cleanup_marker(
    burner, recent_login,
):
    key = "server-generated-openai-receipt"
    receipt = IdempotencyKey.objects.create(
        scope="ai_image", user=burner, key=key, request_hash="b" * 64,
        response_status=200,
        response_body={
            "value": "https://private.example/image.webp",
            "_image_operation": {
                "provider": "openai", "model": "gpt-image-1",
                "key_source": "server_generated",
                "provider_request_state": "completed",
            },
        },
    )
    client = APIClient()
    recent_login(client, burner)

    assert _delete(client, "burner_42").status_code == 202

    receipt.refresh_from_db()
    assert receipt.request_hash is None
    assert receipt.response_body == {
        "_account_deletion_scrubbed": True,
        "_server_generated_ai_image_key": True,
    }
