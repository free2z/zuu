"""Explicit owner-scoped account records; never serialize whole models."""
from django.utils import timezone
from django.db.models import Q

from dj.apps.economy.models import (
    CreatorPayable, PayableJournal, PaymentRequest, CompensationAgreement, LegacyClaim,
    LegacyClaimDecision, ServiceAdmission, ServiceDelivery, FundingDay, PurchaserDay,
    FundingReservation, SupplierOfferApproval, SupplierOfferRevocation, SdkServiceAdmission,
)
from dj.apps.ledger.models import Account, LedgerHold, LedgerSpendCap, LedgerSpendWindow, LedgerDevMarkupPending, LedgerAiSplitQueue, LedgerGatewayCall, PurchaseRefund
from dj.apps.tuzis.models import TuziGrant
from dj.apps.e2ee.models import ChatRequest
from dj.apps.comments.models import ContentReport
from dj.apps.kyc.models import UserProfile, W9, W8BEN, W8BENE
from dj.apps.twitter.models import TwitterProfile, Announcement
from dj.apps.dyte.models import CreatorMeeting
from dj.apps.events.models import Event
from dj.apps.g12f.models import Creator, CreatorFollow, CreatorBlock, CreatorMute, Subscription, PageMentionDelivery
from dj.apps.g12f.blocks import exclude_blocked_events
from dj.apps.handles.models import MessagingHandle
from dj.apps.openai.models import Personality, Conversation, PromptResponse
from dj.apps.social.models import SocialIdentity
from dj.apps.storytime.models import Story, Page
from dj.apps.zauth.models import ZcashIdentity
from dj.util.keyset import keyset_iterator


def rows(query, kind, fields):
    for obj in keyset_iterator(query, chunk_size=250):
        yield {"kind": kind, **{field: getattr(obj, field) for field in fields}}



def composite_rows(query, kind, fields, order):
    """Keyset page composite primary keys without cursor or unbounded reads."""
    query = query.order_by(*order)
    after = None
    while True:
        page = list((query.filter(after) if after is not None else query)[:250])
        if not page:
            return
        for obj in page:
            yield {"kind": kind, **{field: getattr(obj, field) for field in fields}}
        if len(page) < 250:
            return
        last = page[-1]
        after = Q()
        for index, field in enumerate(order):
            term = Q(**{f"{field}__gt": getattr(last, field)})
            for prior in order[:index]:
                term &= Q(**{prior: getattr(last, prior)})
            after |= term

def content_rows(user_id):
    yield from rows(Story.objects.filter(creator_id=user_id), "story", ("id", "title", "slug", "is_published", "created_at", "updated_at"))
    # Do not follow a page's image unless that file belongs to the exporter.
    for obj in keyset_iterator(Page.objects.filter(story__creator_id=user_id).select_related("image"), chunk_size=250):
        yield {"kind": "story_page", "id": obj.pk, "story_id": obj.story_id, "prompt": obj.prompt,
               "content": obj.content, "order": obj.order, "created_at": obj.created_at,
               "updated_at": obj.updated_at, "owned_image_id": obj.image_id if obj.image_id and obj.image.owner_id == user_id else None}
    yield from rows(Personality.objects.filter(creator_id=user_id), "personality", ("id", "display_name", "system_message", "is_public"))
    yield from rows(Conversation.objects.filter(user_id=user_id), "conversation", ("id", "display_name", "is_public", "is_subscriber_only", "created_at", "updated_at"))
    # PromptResponse.user is authoritative; the conversation link alone does
    # not authorize exporting another person's contribution.
    for obj in keyset_iterator(PromptResponse.objects.filter(user_id=user_id).select_related("conversation"), chunk_size=250):
        yield {"kind": "prompt_response", "id": obj.pk,
               "conversation_id": obj.conversation_id if obj.conversation_id and obj.conversation.user_id == user_id else None,
               "user_input": obj.user_input, "response": obj.response,
               "created_at": obj.created_at, "updated_at": obj.updated_at}


def relationship_rows(user_id):
    for model, owner_field, peer, kind in (
        (CreatorFollow, "follower_id", "creator", "following"),
        (CreatorBlock, "blocker_id", "blocked", "blocked"),
        (CreatorMute, "muter_id", "muted", "muted"),
    ):
        for obj in keyset_iterator(model.objects.filter(**{owner_field: user_id}).select_related(peer), chunk_size=250):
            account = getattr(obj, peer)
            visible = account.is_active and (kind != "following" or not CreatorBlock.objects.filter(blocker_id=user_id, blocked_id=account.pk).exists())
            yield {"kind": kind, "username": account.username if visible else None, "created_at": obj.created_at}
    for obj in keyset_iterator(Subscription.objects.filter(fan_id=user_id).select_related("star"), chunk_size=250):
        yield {"kind": "subscription", "username": obj.star.username, "expires": obj.expires,
               "max_price_2z": obj.max_price, "last_charged_at": obj.last_charged_at}
    for obj in keyset_iterator(Subscription.objects.filter(star_id=user_id, expires__gt=timezone.now()).select_related("fan"), chunk_size=250):
        yield {"kind": "subscriber", "username": obj.fan.username, "expires": obj.expires, "max_price_2z": obj.max_price}
    yield from rows(MessagingHandle.objects.filter(user_id=user_id), "messaging_handle", ("handle", "status", "source", "created_at", "updated_at"))


def activity_rows(user_id):
    # The recipient owns notification state. Do not dereference generic targets
    # or expose other accounts' private object identifiers or usernames.
    visible_events = exclude_blocked_events(Event.objects.filter(receiving_user_id=user_id), Creator.objects.get(pk=user_id))
    yield from rows(visible_events, "notification", ("id", "type", "amount", "read", "created_at", "updated_at"))
    yield from rows(ContentReport.objects.filter(reporter_id=user_id), "content_report", ("id", "target_kind", "reason", "details", "status", "created_at"))
    for role in ("author", "recipient"):
        yield from rows(PageMentionDelivery.objects.filter(**{f"{role}_id": user_id}), f"mention_{role}", ("status", "created_at"))
    yield from rows(CreatorMeeting.objects.filter(creator_id=user_id), "meeting", ("meeting_type", "is_public", "live_now", "lifecycle_state", "price_per_minute", "created_at", "last_seen_at"))
    yield from rows(Announcement.objects.filter(subject_user_id=user_id), "announcement", ("kind", "status", "created_at", "updated_at", "posted_at"))
    for role in ("sender", "recipient"):
        query = ChatRequest.objects.filter(**{f"{role}_id": user_id})
        fields = ("id", "charged", "created_at") if role == "sender" else ("id", "created_at")
        yield from rows(query, f"chat_request_{role}", fields)


def identity_rows(user_id):
    yield from rows(SocialIdentity.objects.filter(creator_id=user_id), "social_identity", ("provider", "provider_uid", "handle", "verified_at"))
    yield from rows(ZcashIdentity.objects.filter(creator_id=user_id), "zcash_identity", ("zcash_address", "created_at"))
    yield from rows(TwitterProfile.objects.filter(creator_id=user_id), "legacy_twitter_identity", ("twitter_id", "username", "name", "description", "allow_login", "is_public", "created_at"))
    yield from rows(UserProfile.objects.filter(user_id=user_id), "kyc_profile", ("is_us", "is_individual", "application_status", "rejection_reason", "tax_form_signature", "created_at", "updated_at"))
    yield from rows(W9.objects.filter(profile__user_id=user_id), "w9_fields", ("full_name", "business_name", "tax_classification", "llc_tax_classification", "exempt_payee_code", "exemption_from_fatca", "address", "city_state_zip", "requester_name_address", "account_numbers", "ssn", "ein", "created_at", "updated_at"))
    for form in keyset_iterator(W8BEN.objects.filter(profile__user_id=user_id), chunk_size=250):
        fields = ("full_name", "permanent_residence_address", "permanent_residence_city_state_zip", "mailing_address", "mailing_city_state_zip", "tin", "foreign_tin", "foreign_tin_not_required", "reference_numbers", "date_of_birth", "certification", "certification_date", "print_name", "created_at", "updated_at")
        yield {"kind": "w8ben_fields", **{name: getattr(form, name) for name in fields}, "citizenship_country": str(form.citizenship_country), "permanent_residence_country": str(form.permanent_residence_country), "mailing_country": str(form.mailing_country)}
    yield from rows(W8BENE.objects.filter(profile__user_id=user_id), "w8bene_form", ("created_at", "updated_at"))


def finance_rows(user_id):
    yield from rows(CreatorPayable.objects.filter(creator_id=user_id), "payable", ("currency", "balance_nusd", "held_nusd", "created_at"))
    yield from rows(PayableJournal.objects.filter(account__creator_id=user_id), "payable_journal", ("kind", "delta_nusd", "allocated_m2z", "created_at"))
    yield from rows(PaymentRequest.objects.filter(account__creator_id=user_id), "payout", ("id", "amount_nusd", "state", "created_at", "updated_at"))
    yield from rows(CompensationAgreement.objects.filter(creator_id=user_id), "compensation_agreement", ("contract_version", "accepted_at", "effective_at", "revoked_at"))
    yield from rows(LegacyClaim.objects.filter(creator_id=user_id), "legacy_claim", ("snapshot_at", "usage_snapshot_m2z", "classification", "liability_nusd"))

    yield from rows(LegacyClaimDecision.objects.filter(claim__creator_id=user_id), "legacy_claim_decision", ("classification", "liability_nusd", "created_at"))
    yield from rows(ServiceAdmission.objects.filter(creator_id=user_id), "service_admission", ("id", "service", "admitted_at"))
    yield from rows(SdkServiceAdmission.objects.filter(subject_id=user_id), "sdk_service_admission", ("id",))
    yield from rows(ServiceDelivery.objects.filter(admission__creator_id=user_id), "service_delivery", ("id", "service", "allocated_m2z", "created_at"))
    yield from rows(FundingDay.objects.filter(account__owner_id=user_id), "funding_day", ("day", "opening_m2z", "incoming_m2z", "reserved_m2z"))
    yield from rows(PurchaserDay.objects.filter(purchaser_id=user_id), "purchaser_day", ("day", "sold_nusd", "reserved_nusd"))
    for role in ("recipient", "purchaser"):
        yield from rows(FundingReservation.objects.filter(**{f"{role}_id": user_id}), f"funding_{role}", ("amount_m2z", "sale_nusd", "state", "created_at"))
    yield from rows(SupplierOfferApproval.objects.filter(creator_id=user_id), "supplier_offer", ("id", "markup_bps", "approved_at"))
    yield from rows(SupplierOfferRevocation.objects.filter(offer__creator_id=user_id), "supplier_offer_revocation", ("created_at",))
    yield from rows(LedgerHold.objects.filter(account__owner_id=user_id), "ledger_hold", ("amount", "created_at", "expires_at"))
    yield from composite_rows(LedgerSpendCap.objects.filter(account__owner_id=user_id), "spend_cap", ("cap_m2z", "period", "markup_bps", "revoked_at", "updated_at"), ("account_id", "app_id"))
    account_ids = Account.objects.filter(owner_id=user_id).values("id")
    yield from composite_rows(LedgerSpendWindow.objects.filter(account_id__in=account_ids), "spend_window", ("window_start", "spent_m2z", "held_m2z"), ("account_id", "app_id", "window_start"))
    yield from rows(LedgerDevMarkupPending.objects.filter(developer_creator_id=user_id), "developer_markup_pending", ("amount_m2z", "created_at"))
    yield from rows(LedgerAiSplitQueue.objects.filter(developer_creator_id=user_id), "developer_markup_queued", ("developer_m2z", "created_at"))
    yield from rows(LedgerGatewayCall.objects.filter(account__owner_id=user_id), "gateway_call", ("phase", "created_at", "expires_at", "completed_at"))
    yield from rows(TuziGrant.objects.filter(creator_id=user_id), "credit_grant", ("amount", "balance_after", "reason", "created_at"))
    yield from rows(PurchaseRefund.objects.filter(account__owner_id=user_id), "purchase_refund", ("rail", "credited_m2z", "refunded_m2z", "created_at", "updated_at"))
