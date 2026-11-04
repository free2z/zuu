"""Write-boundary actor evidence for translation failure attribution."""

from django.db import connection, transaction

from dj.apps.g12f.models import ZPageMutationActor, zPage
from dj.apps.g12f.variants import content_digest, occupied_translation


ACTION_FOR_FAILURE = {
    "source_changed": (ZPageMutationActor.SOURCE_CONTENT, "", "digest"),
    "same_language": (
        ZPageMutationActor.SOURCE_LANGUAGE, "target", "language"
    ),
    "variant_changed": (
        ZPageMutationActor.VARIANT_CONTENT, "target", "digest"
    ),
    "variant_published": (
        ZPageMutationActor.VARIANT_PUBLISHED, "target", "digest"
    ),
    "zpage_gone": (ZPageMutationActor.PAGE_DELETED, "", ""),
    "not_owner": (ZPageMutationActor.OWNERSHIP_CHANGED, "", "owner"),
}


#Later recorded writes that END the state an earlier event vouched for, so
#they must be able to be "the latest write" too. A buyer who creates draft X
#and then deletes it has not vouched for an X that something untracked
#recreates afterwards. (Adversarial review of.)
#For a publication conflict the latest event must be a PUBLICATION by the
#buyer of the observed state. The API records an edit to a translation that
#stays published as a fresh ``VARIANT_PUBLISHED`` row (after its content
#row), so publish-then-edit stays attributable, while a later content row on
#its own -- a draft edit, possibly republished by an untracked write -- ends
#the evidence. (; independent review of.)
INVALIDATED_BY = {
    ZPageMutationActor.VARIANT_CONTENT: (ZPageMutationActor.VARIANT_DELETED,),
    ZPageMutationActor.VARIANT_PUBLISHED: (
        ZPageMutationActor.VARIANT_CONTENT,
        ZPageMutationActor.VARIANT_DELETED,
        ZPageMutationActor.VARIANT_UNPUBLISHED,
    ),
}


def record_authenticated_write(
    *, zpage_id, actor, action, language="", state_digest="",
):
    """Record the authenticated actor alongside the write in its transaction.

    Callers pass ``request.user`` only after the owner-scoped object lookup and
    only after the corresponding state change succeeded. No request-body actor
    claims or inference from model provenance are accepted here.
    """
    if not getattr(actor, "is_authenticated", False) or actor.pk is None:
        return None
    return ZPageMutationActor.objects.create(
        zpage_id=zpage_id,
        actor_id=actor.pk,
        action=action,
        language=language or "",
        state_digest=str(state_digest or ""),
    )


def authenticated_actor_caused(
    *, code, zpage_id, actor_id, language, after, before, state_digest="",
):
    """Whether the LAST recorded write of this kind in the window was the buyer's.

    The latest matching event is chosen first, whoever wrote it, and only then
    checked for the buyer and for the state the worker observed. Asking "did
    the buyer EVER write this state in the window" instead lets an older event
    take credit for a later write: the buyer edits D -> X -> D through the API
    and an untracked write then puts X back -- the buyer's first row matches X
    and would bill them for a state they had already undone. (Adversarial
    review of.) A later recorded write by anyone else, or a state that no
    longer matches the latest row, is not the buyer's.
    """
    action_and_language = ACTION_FOR_FAILURE.get(code)
    if action_and_language is None or actor_id is None or after is None:
        return False
    action, language_mode, state_mode = action_and_language
    events = ZPageMutationActor.objects.filter(
        zpage_id=zpage_id,
        action__in=(action, *INVALIDATED_BY.get(action, ())),
        occurred_at__gt=after,
    )
    if before is not None:
        events = events.filter(occurred_at__lte=before)
    if language_mode == "target" and state_mode != "language":
        # Per-language rows (variants): only that language's history counts.
        events = events.filter(language=language or "")
    latest = events.order_by("-occurred_at", "-pk").first()
    if latest is None or latest.actor_id != actor_id:
        return False
    if latest.action != action:
        return False
    if state_mode == "language":
        # A relabel: the latest relabel must be the one INTO the target.
        return (
            latest.language == (language or "")
            and latest.state_digest == (language or "")
        )
    if language_mode != "target" and latest.language != "":
        return False
    if state_mode in {"digest", "owner"}:
        return latest.state_digest == str(state_digest or "")
    return latest.state_digest == ""


def observed_state_digest(*, code, zpage_id, language):
    """Current state involved in a conflict, used to reject stale actor rows."""
    if code == "zpage_gone":
        return ""
    page = zPage.objects.filter(pk=zpage_id).first()
    if page is None:
        return ""
    if code == "source_changed":
        return content_digest(page.content)
    if code == "same_language":
        return page.source_language or ""
    if code == "not_owner":
        return str(page.creator_id)
    if code in {"variant_changed", "variant_published"}:
        occupant = occupied_translation(page.pk, language)
        return str(occupant[2]) if occupant is not None else ""
    return ""


def prune_mutation_actors(*, limit=10_000, now=None):
    """Delete a bounded batch of actor rows outside every attribution window."""
    from django.utils import timezone

    from dj.apps.g12f.translation import charges, settlement

    if limit < 1:
        raise ValueError("prune limit must be at least one row")
    now = now or timezone.now()
    cutoff = now - (
        settlement.failure_window() + charges.abandoned_hard_after()
    )
    with transaction.atomic():
        # Maintenance work must not wait indefinitely behind a live writer.
        if connection.vendor == "postgresql":
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT set_config('lock_timeout', %s, true), "
                    "set_config('statement_timeout', %s, true)",
                    ["500ms", "5000ms"],
                )
        stale_ids = list(
            ZPageMutationActor.objects.filter(occurred_at__lt=cutoff)
            .order_by("occurred_at", "pk")
            .values_list("pk", flat=True)[:limit]
        )
        if not stale_ids:
            return 0
        return ZPageMutationActor.objects.filter(pk__in=stale_ids).delete()[0]
