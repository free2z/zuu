"""Admin for the registry and the grants.

``F2ZApplicationAdmin`` is registered by django-oauth-toolkit's own admin
module through ``OAUTH2_PROVIDER['APPLICATION_ADMIN_CLASS']`` (it registers
the swapped model itself, so this module must not register it again). The
one operator action that lives here and nowhere else is setting
``approved_markup_bps`` -- markup approval is manual by decision
.
"""
import logging

from django import forms
from django.contrib import admin, messages
from django.db import transaction
from django.db.models import Case, IntegerField, Value, When

from .models import AiOutputReport, AppAuthorization, AudienceChange, F2ZApplication

logger = logging.getLogger(__name__)


class AudienceChangeInline(admin.TabularInline):
    """Read-only history of ``child_directed`` (append-only by design)."""

    model = AudienceChange
    extra = 0
    can_delete = False
    fields = ("created_at", "previous", "child_directed", "changed_by", "via")
    readonly_fields = fields

    def has_add_permission(self, request, obj=None):
        return False

    def has_change_permission(self, request, obj=None):
        return False


class F2ZApplicationAdmin(admin.ModelAdmin):
    list_display = (
        "name", "client_id", "client_type", "user", "first_party",
        "markup_bps", "approved_markup_bps", "child_directed", "frozen", "created",
    )
    list_filter = ("client_type", "first_party", "child_directed", "frozen")
    search_fields = ("name", "client_id", "user__username")
    readonly_fields = ("id", "client_id", "created", "updated", "client_secret")
    raw_id_fields = ("user",)
    inlines = (AudienceChangeInline,)
    # The library's `get_absolute_url` reverses a URL name this project does
    # not mount; a "view on site" link would 500.
    view_on_site = False
    fieldsets = (
        (None, {"fields": ("id", "client_id", "name", "user", "client_type",
                           "first_party", "frozen")}),
        ("Redirects and scopes", {"fields": ("redirect_uris", "allowed_origins",
                                              "allowed_scopes",
                                              "allow_zcash_assertion")}),
        ("Markup (approval is manual)", {"fields": ("markup_bps", "approved_markup_bps")}),
        ("Consent screen", {"fields": ("child_directed",
                                       "default_spend_cap_2z", "default_cap_period",
                                       "logo_url", "privacy_url", "terms_url")}),
        ("Timestamps", {"fields": ("created", "updated")}),
    )

    def save_model(self, request, obj, form, change):
        previous = None
        if change and "child_directed" in form.changed_data:
            previous = (F2ZApplication.objects.filter(pk=obj.pk)
                        .values_list("child_directed", flat=True).first())
        super().save_model(request, obj, form, change)
        if "child_directed" in form.changed_data:
            AudienceChange.record(obj, previous=previous, by=request.user,
                                  via=AudienceChange.Via.ADMIN)
        # Keep the ledger's registry projection in step (a no-op until L2).
        from .ledger_projection import sync_application

        sync_application(obj)


@admin.register(AppAuthorization)
class AppAuthorizationAdmin(admin.ModelAdmin):
    """Read-only. A grant changes only through ``dj.apps.oidc.consent``:
    a scope reduction or revocation must move ``generation`` and publish
    it, and a deleted-then-recreated grant would start again at generation
    1 with old tokens still in the table (codex adversarial review). The
    revoke endpoint is the operator's tool too."""

    list_display = ("user", "application", "scope", "spend_cap_2z", "cap_period",
                    "markup_bps", "generation", "revoked_at", "consented_at")
    list_filter = ("cap_period",)
    search_fields = ("user__username", "application__name", "application__client_id")
    raw_id_fields = ("user", "application")

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


# Referenced so a reader of this module sees the registry model; the
# registration itself is the library's (see the module docstring).
__all__ = ["F2ZApplicationAdmin", "AppAuthorizationAdmin", "AudienceChangeInline", "F2ZApplication"]


def _report_version(updated_at) -> str:
    return updated_at.isoformat() if updated_at else ""


class AiOutputReportAdminForm(forms.ModelForm):
    """``status``/``staff_notes`` plus the version the moderator was shown.

    The reporter can change a report (escalate it to ``unsafe``) while a
    moderator has it open. Saving "resolved" from that stale page would close
    a complaint nobody reviewed, and drop it out of the open queue the unsafe
    alert points at. So the page carries the ``updated_at`` it rendered, and a
    save against any newer version is refused: reload, review, then resolve.
    """

    seen_version = forms.CharField(widget=forms.HiddenInput, required=False)

    class Meta:
        model = AiOutputReport
        fields = ("status", "staff_notes")

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if not self.is_bound and self.instance.pk:
            self.fields["seen_version"].initial = _report_version(self.instance.updated_at)

    def clean(self):
        cleaned = super().clean()
        current = AiOutputReport.objects.filter(pk=self.instance.pk).values_list(
            "updated_at", flat=True).first()
        if _report_version(current) != cleaned.get("seen_version"):
            raise forms.ValidationError(STALE_REPORT_MESSAGE)
        return cleaned


STALE_REPORT_MESSAGE = ("The reporter changed this report after you opened it. "
                        "Reload the page and review the change before saving.")


@admin.register(AiOutputReport)
class AiOutputReportAdmin(admin.ModelAdmin):
    """Free2Z moderation's queue of in-app AI output reports.

    ``unsafe`` sorts first, then oldest first. There is no AI content to
    look at -- the gateway keeps none -- so triage works from the app, the
    model, the reason and the reporter's optional one-line detail; act with
    the app tools (freeze the app, contact its developer) and record the
    outcome in ``status`` and ``staff_notes``. Runbook:
    docs/moderation/ai-output-reports.md."""

    form = AiOutputReportAdminForm
    list_display = ("id", "reason", "status", "application", "model", "created_at")
    list_filter = ("status", "reason")
    search_fields = ("=id", "=call_id", "application__client_id", "application__name")
    readonly_fields = ("id", "application", "reporter", "call_id", "model", "reason",
                       "detail", "unsafe_at", "created_at", "updated_at")
    fields = readonly_fields + ("status", "staff_notes", "seen_version")

    def get_queryset(self, request):
        return super().get_queryset(request).select_related("application").annotate(
            _priority=Case(When(reason="unsafe", then=Value(0)), default=Value(1),
                           output_field=IntegerField()),
        ).order_by("_priority", "created_at")

    def save_model(self, request, obj, form, change):
        """Write only what staff own, under the row lock the SDK intake
        takes, and only if the report is still the version the moderator
        saw (the form checked it; this re-checks it under the lock, which
        closes the window between the form's read and this write)."""
        with transaction.atomic():
            current = type(obj).objects.select_for_update().filter(pk=obj.pk).values_list(
                "updated_at", flat=True).first()
            if _report_version(current) != form.cleaned_data.get("seen_version"):
                logger.warning("ai report %s: stale moderator save refused", obj.pk)
                if request is not None:
                    messages.error(request, STALE_REPORT_MESSAGE)
                return
            obj.save(update_fields=["status", "staff_notes", "updated_at"])

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
