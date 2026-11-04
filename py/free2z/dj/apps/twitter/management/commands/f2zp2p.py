"""Operator entry point for @F2ZP2P announcements.

    manage.py f2zp2p check              # config + which account we post as
    manage.py f2zp2p check --offline    # config only, no X call
    manage.py f2zp2p status             # ledger counts + recent failures
    manage.py f2zp2p canary --zpage 123 --yes
    manage.py f2zp2p canary --comment <uuid> --yes

``canary`` posts ONE real announcement for one existing public object through
exactly the production code path (copy, image, upload, create), regardless of
F2ZP2P_ANNOUNCEMENTS and the hourly caps -- but still only in the live
namespace. It prints the X post id, which is also stored on the ledger row.
Run it as a detached Job, not `kubectl exec` (docs/agent-operations.md §4).

No secret value is ever printed: only whether each variable is set.
"""
import json
import os
import uuid

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from dj.apps.twitter import announcements, client_x
from dj.apps.twitter.models import Announcement

ENV_NAMES = (
    "TWITTER_API_KEY", "TWITTER_API_KEY_SECRET", "TWITTER_ACCESS_KEY",
    "TWITTER_ACCESS_KEY_SECRET", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
)


class Command(BaseCommand):
    help = "Inspect and canary the @F2ZP2P announcement pipeline."

    def add_arguments(self, parser):
        sub = parser.add_subparsers(dest="action", required=True)
        check = sub.add_parser("check")
        check.add_argument("--offline", action="store_true")
        sub.add_parser("status")
        canary = sub.add_parser("canary")
        target = canary.add_mutually_exclusive_group(required=True)
        target.add_argument("--zpage", type=int)
        target.add_argument("--comment")
        canary.add_argument("--yes", action="store_true",
                            help="really post to X")

    def handle(self, *args, **options):
        getattr(self, f"_{options['action']}")(options)

    def _emit(self, payload):
        self.stdout.write(json.dumps(payload, indent=2, default=str))

    def _check(self, options):
        payload = {
            "F2ZP2P_ANNOUNCEMENTS": settings.F2ZP2P_ANNOUNCEMENTS,
            "NAMESPACE": settings.NAMESPACE,
            "F2ZP2P_LIVE_NAMESPACE": settings.F2ZP2P_LIVE_NAMESPACE,
            "effective_mode": announcements.effective_mode(),
            "copy_model": settings.F2ZP2P_COPY_MODEL,
            "image_enabled": settings.F2ZP2P_IMAGE_ENABLED,
            "image_model": settings.OPENAI_IMAGE_MODEL,
            "hourly_cap": settings.F2ZP2P_HOURLY_CAP,
            "author_hourly_cap": settings.F2ZP2P_AUTHOR_HOURLY_CAP,
            "env_set": {name: bool(os.environ.get(name)) for name in ENV_NAMES},
            "provider_paused": announcements._provider_paused(),
        }
        if not options["offline"]:
            try:
                me = client_x.verify_credentials()
                payload["x_account"] = {
                    "id": me.get("id"), "username": me.get("username"),
                }
            except (client_x.XProviderError, client_x.XNotConfigured) as exc:
                payload["x_account_error"] = str(exc)
        self._emit(payload)

    def _status(self, options):
        counts = {
            status: Announcement.objects.filter(status=status).count()
            for status, _ in Announcement.STATUS_CHOICES
        }
        recent = list(Announcement.objects.filter(status__in=(
            Announcement.FAILED, Announcement.NEEDS_RECONCILIATION,
        )).order_by("-updated_at").values(
            "id", "event_key", "status", "reason", "last_status_code",
            "updated_at",
        )[:20])
        self._emit({"counts": counts, "recent_problems": recent})

    def _canary(self, options):
        if not options["yes"]:
            raise CommandError("refusing to post without --yes")
        if announcements.effective_mode(force_live=True) != announcements.LIVE:
            raise CommandError(
                f"NAMESPACE={settings.NAMESPACE!r} is not the live namespace "
                f"{settings.F2ZP2P_LIVE_NAMESPACE!r}; nothing posted"
            )
        if options["zpage"] is not None:
            key = announcements.zpage_event_key(options["zpage"])
            fields = {"kind": Announcement.ZPAGE_FIRST_PUBLISHED,
                      "zpage_id": options["zpage"]}
        else:
            # Canonical spelling: the event key must match the one the
            # producer wrote, whatever case/hyphenation was typed.
            try:
                comment_id = uuid.UUID(str(options["comment"]))
            except ValueError as exc:
                raise CommandError("--comment must be a UUID") from exc
            key = announcements.comment_event_key(comment_id)
            fields = {"kind": Announcement.COMMENT_CREATED,
                      "comment_id": comment_id}
        ann, _created = Announcement.objects.get_or_create(
            event_key=key, defaults=fields,
        )
        resettable = (
            Announcement.PENDING, Announcement.FAILED,
            Announcement.SUPPRESSED, Announcement.DRY_RUN,
        )
        # Conditional in the UPDATE itself: a worker may be generating or
        # posting this very row, and resetting it would license a second
        # create (codex review).
        reset = Announcement.objects.filter(
            pk=ann.pk, status__in=resettable,
        ).update(
            status=Announcement.PENDING, next_attempt_at=None,
            reason="canary", attempts=0,
        )
        if not reset:
            ann.refresh_from_db()
            raise CommandError(
                f"{key} is {ann.status} (x_post_id={ann.x_post_id}); "
                "it is posted or in flight -- pick another object"
            )
        result = announcements.run_announcement(ann.pk, force_live=True)
        ann.refresh_from_db()
        self._emit({
            "event_key": key, "result": result, "status": ann.status,
            "reason": ann.reason, "x_post_id": ann.x_post_id,
            "copy_source": ann.copy_source, "image_source": ann.image_source,
            "text": ann.text, "last_status_code": ann.last_status_code,
            "last_error": ann.last_error,
        })
        if ann.status != Announcement.POSTED:
            raise CommandError(f"canary did not post: {ann.status}")
