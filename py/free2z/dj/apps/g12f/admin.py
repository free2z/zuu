import json
from itertools import chain

from taggit.forms import TagWidget
from django import forms
from django.contrib import admin
from django.core.exceptions import ValidationError
from django.core.serializers.json import DjangoJSONEncoder
from django.http import HttpRequest
from django.utils.crypto import constant_time_compare, salted_hmac
from django.utils.html import format_html
from django.forms import ModelForm

from taggit.forms import TagField

from dj.apps.g12f.models.viewed import ViewedTransaction
from dj.apps.g12f.models.poll import Poll
from dj.apps.g12f.models.comment import PageComment


from dj.apps.g12f.models import (
    zPage, Creator, Transaction, Address, Subscription,
    Series, PageOrder, ZPageTranslation, ZPageVariant, AccountDeletionEvent,
)
from dj.apps.g12f.models.zpage import LEGACY_UNDETERMINED_LANGUAGE
from dj.apps.g12f.usernames import is_forbidden_username
from dj.apps.ktauth.epoch import (
    EVENT_ADMIN_CREDENTIAL_EDIT,
    bump_account_epoch,
)
from dj.apps.g12f.serializers.zpage import (
    DraftTranslationVariantLimitConflict,
    PublishedTranslationVariantLimitConflict,
    enforce_draft_translation_variant_limit,
    enforce_published_translation_variant_limit,
    lock_zpages_for_translation_write,
)

from f2z import languages


class CreatorAdminForm(ModelForm):
    """Reject an admin edit when the Creator changed after the form loaded."""

    # These fields cannot make an admin save restore stale security/trust state:
    # tuzis is read-only here and excluded by Creator.save(); updated_at is
    # bookkeeping; last_login is activity telemetry. Excluding them prevents
    # balance churn or repeated logins from denying an emergency admin action.
    FINGERPRINT_EXCLUDED_FIELDS = frozenset({
        'tuzis',
        # Derived ranking cache; concurrent recomputes must not make an
        # otherwise valid security/trust edit stale.
        'total',
        'updated_at',
        'last_login',
    })
    FINGERPRINT_M2M_FIELDS = (
        'groups',
        'user_permissions',
    )

    _loaded_row_fingerprint = forms.CharField(
        required=False,
        widget=forms.HiddenInput,
    )

    class Meta:
        model = Creator
        fields = '__all__'

    @staticmethod
    def _row_fingerprint(instance):
        # Cover every persisted column, including writers that intentionally
        # use QuerySet.update() and therefore bypass auto_now. The HMAC keeps a
        # posted token from being forged by changing the serialized values.
        payload = {
            field.attname: field.value_from_object(instance)
            for field in instance._meta.concrete_fields
            if field.name not in CreatorAdminForm.FINGERPRINT_EXCLUDED_FIELDS
        }
        # ModelForm.save_m2m() runs after save_model() and writes these
        # privilege-bearing relations from the submitted form. A concrete-row
        # fingerprint alone cannot see a concurrent group/permission
        # revocation, so a stale admin page could otherwise add it back.
        payload['__security_m2m__'] = {
            field_name: sorted(
                getattr(instance, field_name).values_list('pk', flat=True)
            )
            for field_name in CreatorAdminForm.FINGERPRINT_M2M_FIELDS
        }
        serialized = json.dumps(
            payload,
            cls=DjangoJSONEncoder,
            sort_keys=True,
            separators=(',', ':'),
        )
        return salted_hmac(
            'g12f.CreatorAdminForm.row',
            serialized,
        ).hexdigest()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if not self.is_bound and self.instance.pk:
            self.initial['_loaded_row_fingerprint'] = (
                self._row_fingerprint(self.instance)
            )

    def clean_username(self):
        """Apply the public route namespace policy to staff edits too."""
        value = self.cleaned_data['username']
        retaining_current_username = (
            self.instance.pk is not None
            and self.instance.username.lower() == value.lower()
        )
        if (
            is_forbidden_username(value)
            and not retaining_current_username
        ):
            raise ValidationError(
                "System reserved name, please choose another!"
            )
        if Creator.objects.filter(
            username__iexact=value
        ).exclude(pk=self.instance.pk).exists():
            raise ValidationError(
                "A user with that username already exists!"
            )
        return value

    def clean(self):
        cleaned_data = super().clean()
        if not self.instance.pk:
            self._validated_security_m2m = {
                field_name: set()
                for field_name in self.FINGERPRINT_M2M_FIELDS
            }
            return cleaned_data

        # ModelAdmin.changeform_view wraps validation and saving in one atomic
        # transaction. Hold the row lock through save_model() so another
        # security writer cannot land between this comparison and the save.
        current = Creator.objects.select_for_update().get(pk=self.instance.pk)
        current_fingerprint = self._row_fingerprint(current)
        loaded_fingerprint = cleaned_data.get('_loaded_row_fingerprint')
        if not loaded_fingerprint or not constant_time_compare(
            loaded_fingerprint,
            current_fingerprint,
        ):
            raise ValidationError(
                "This creator changed after you opened the form. Reload the "
                "page, review the current security state, and try again."
            )
        # Keep the validated baseline for _save_m2m(). A Creator row lock
        # serializes other CreatorAdmin requests, but cannot block a writer
        # that touches only an auth join table. Applying the submitted delta
        # to the then-current relation (instead of ModelForm's wholesale
        # ``set()``) means an unchanged stale selection cannot restore a
        # revocation that lands after this validation.
        self._validated_security_m2m = {
            field_name: set(
                getattr(current, field_name).values_list('pk', flat=True)
            )
            for field_name in self.FINGERPRINT_M2M_FIELDS
        }
        return cleaned_data

    def _save_m2m(self):
        """Merge privilege edits as deltas so concurrent changes survive."""
        for field in chain(
            self.instance._meta.many_to_many,
            self.instance._meta.private_fields,
        ):
            if not hasattr(field, 'save_form_data'):
                continue
            if self._meta.fields and field.name not in self._meta.fields:
                continue
            if self._meta.exclude and field.name in self._meta.exclude:
                continue
            if field.name not in self.cleaned_data:
                continue
            if field.name not in self.FINGERPRINT_M2M_FIELDS:
                field.save_form_data(
                    self.instance,
                    self.cleaned_data[field.name],
                )
                continue

            loaded_pks = self._validated_security_m2m[field.name]
            submitted_pks = {
                value.pk for value in self.cleaned_data[field.name]
            }
            manager = getattr(self.instance, field.name)
            manager.remove(*(loaded_pks - submitted_pks))
            manager.add(*(submitted_pks - loaded_pks))


@admin.register(Subscription)
class SubscriptionAdmin(admin.ModelAdmin):
    list_display = ['star', 'fan', 'expires', 'max_price']


@admin.register(ViewedTransaction)
class ViewedTransactionAdmin(admin.ModelAdmin):
    autocomplete_fields = ['zpage']


@admin.register(Poll)
class PollAdmin(admin.ModelAdmin):
    pass


@admin.register(Creator)
class CreatorAdmin(admin.ModelAdmin):
    form = CreatorAdminForm
    search_fields = ['username', 'email', 'p2paddr']
    list_display = ['username', 'tuzis', 'total', 'is_verified', 'strikes', 'p2paddr']
    autocomplete_fields = ['avatar_image', 'banner_image']
    # Issue. `Creator.save()` refuses to write ledger-owned columns, and
    # `ModelAdmin.save_model()` does a plain `obj.save()` — so an editable
    # `tuzis` box here would silently discard whatever was typed into it. Make
    # that honest rather than a lie.
    #
    # Read-only is also the right answer on its own merits: the admin change
    # form is the worst possible instance of the stale-clobber bug (a human can
    # sit on an open form for minutes before submitting a balance read at page
    # load), and a hand-typed balance leaves no audit trail. To grant 2Z by
    # hand, use `manage.py grant_tuzis <username> <amount> --reason "..."`
    #it credits through `dj.apps.tuzis.ledger` and writes a
    # `TuziGrant` receipt in the same transaction. (`credit_creators` is the
    # on-chain ZEC purchase loop, not an operator tool.)
    #
    # Issue. `total` is excluded from full saves for a different reason:
    # it is a derived display/ranking cache. Editing it here would likewise be
    # silently discarded; repair the authoritative zPage rows and run
    # `creator.cache_total()` instead.
    readonly_fields = ['tuzis', 'total']

    #Admin edits to these are account-ownership events.
    #
    #`password` only. Staff replacing the password hash is the literal "the
    #account changed hands" path performed by a third party, and it is the one
    #ownership event the account holder gets no signal of their own about.
    #
    #`username` is deliberately NOT here, and the reason is consistency rather
    #than oversight (codex adversarial review): `dj.apps.ktauth.epoch` records
    #that a username change moves the *handle* rather than the account, that
    #A15 is retained per handle, and that the resulting per-account /
    #per-handle mismatch is an activation blocker no increment can fix. The
    #self-service rename does not count; counting the staff one would spend
    #an A18b step on a case correction (`Alice` -> `alice`) that changes
    #neither the effective handle nor any principal.
    #
    #`kt_account_epoch` is deliberately NOT in
    #`CreatorAdminForm.FINGERPRINT_EXCLUDED_FIELDS`: an increment landing
    #while this form was open means a credential change committed underneath
    #the reviewer, and the stale-form guard should refuse exactly that. The
    #excluded set is for churn (a balance, a login timestamp); an ownership
    #event is not churn.
    OWNERSHIP_FIELDS = frozenset({'password'})

    def save_model(self, request: HttpRequest, obj, form, change):
        super().save_model(request, obj, form, change)
        # Only on an edit. Creating a Creator here has no predecessor to
        # invalidate, and its counter starts at the column default.
        if change and self.OWNERSHIP_FIELDS.intersection(form.changed_data):
            bump_account_epoch(obj.pk, event=EVENT_ADMIN_CREDENTIAL_EDIT)


class WideTagWidget(TagWidget):
    def __init__(self, attrs=None):
        if attrs is None:
            attrs = {}
        attrs['style'] = 'width: 500px'
        super().__init__(attrs=attrs)


def _clean_content_language(value, *, allow_legacy):
    """Normalize a hand-typed language tag, or raise a form error.

    The language columns lost their `choices=` list in  M1 -- language is
    data now, not an enum -- which also took away the admin's `<select>` and
    the free validation that came with it. Without this, staff could type
    "English" or "de-DEU" into a text box and store it: a value no resolver
    matches, that renders as a raw subtag to readers, and that occupies its own
    row in every unique index keyed on language.

    `und` is accepted when `allow_legacy` is set, because it is the value most
    existing pages already hold: a validator that rejected it would make every
    legacy page unsaveable in the admin without first relabelling it.
    """
    if value in (None, ""):
        return value
    if allow_legacy and value == LEGACY_UNDETERMINED_LANGUAGE:
        return value
    try:
        return languages.normalize(value, allow_missing=False)
    except languages.LanguageError as exc:
        raise ValidationError(str(exc)) from exc


class PageForm(ModelForm):
    tags = TagField(widget=WideTagWidget, required=False)

    class Meta:
        model = zPage
        fields = '__all__'

    def clean_source_language(self):
        return _clean_content_language(
            self.cleaned_data.get('source_language'), allow_legacy=True
        )

    def clean(self):
        """Refuse a relabel that collides with an existing translation.

        The same rule the API enforces ( §3.2). Staff reach the column
        through a ModelForm rather than the serializer, so without this the
        admin would commit a page whose source language duplicates one of its
        translations -- which the dual-write mirror then declines, leaving the
        two shapes permanently disagreeing.
        """
        cleaned = super().clean()
        language = cleaned.get('source_language')
        if (
            self.instance.pk
            and language
            and language != self.instance.source_language
            and ZPageTranslation.objects.filter(
                zpage_id=self.instance.pk, language=language
            ).exists()
        ):
            self.add_error('source_language', ValidationError(
                f"A {language} translation already exists for this page. "
                "Delete or merge it before making it the source language."
            ))
        return cleaned


class ZPageTranslationForm(ModelForm):
    class Meta:
        model = ZPageTranslation
        fields = '__all__'

    def clean_language(self):
        # No `allow_legacy`: `und` is never a translation's language, only a
        # legacy source label.
        return _clean_content_language(
            self.cleaned_data.get('language'), allow_legacy=False
        )

    def clean(self):
        """Apply the API's published-translation ceiling to admin writes.

        ``ModelAdmin.changeform_view`` wraps every POST in one atomic
        transaction *before* it calls ``form.is_valid()`` and holds it through
        ``save_model()``.  Taking the parent lock here therefore serializes
        this count with the actual legacy save and its synchronous mirror
        write, rather than releasing it after validation and reopening the
        65th-language race.

        Use ``cleaned_data`` for the proposed destination and language:
        ModelForm has not reconstructed ``self.instance`` from this POST yet.
        The persisted row is fetched separately only to tell the shared
        decision helper whether an in-page published rename frees a slot.
        """
        cleaned = super().clean()
        destination = cleaned.get("zpage")
        language = cleaned.get("language")
        if (
            destination is None
            or language is None
            or "is_published" not in cleaned
        ):
            return cleaned

        persisted = None
        original_page_id = None
        if self.instance.pk:
            persisted = ZPageTranslation.objects.filter(
                pk=self.instance.pk
            ).only("pk", "zpage_id", "language", "is_published").first()
            if persisted is not None:
                original_page_id = persisted.zpage_id

        locked_pages = lock_zpages_for_translation_write(
            destination.pk, original_page_id,
        )
        locked_destination = locked_pages.get(destination.pk)
        if locked_destination is None:
            self.add_error("zpage", ValidationError(
                "This page no longer exists. Reload the form and try again."
            ))
            return cleaned

        # Re-read after taking the parent locks.  The normal API/admin writers
        # use the same lock, so this is the persisted row whose save follows
        # this validation; direct/bulk ORM mutation is intentionally outside
        # this managed-write guard (see the shared helper's contract).
        if self.instance.pk:
            persisted = ZPageTranslation.objects.filter(
                pk=self.instance.pk
            ).only("pk", "zpage_id", "language", "is_published").first()

        try:
            enforce_published_translation_variant_limit(
                locked_destination,
                language,
                cleaned["is_published"],
                replacing_translation=persisted,
            )
            enforce_draft_translation_variant_limit(
                locked_destination,
                language,
                cleaned["is_published"],
                replacing_translation=persisted,
            )
        except (
            PublishedTranslationVariantLimitConflict,
            DraftTranslationVariantLimitConflict,
        ) as exc:
            # The API exposes this as a 409; an HTML form cannot, so attach the
            # exact actionable detail to the publish control and leave the
            # transaction without saving either the legacy row or its mirror.
            self.add_error("is_published", ValidationError(
                exc.detail, code=exc.default_code,
            ))
        return cleaned


@admin.register(zPage)
class PageAdmin(admin.ModelAdmin):
    form = PageForm
    list_filter = ["is_published"]
    list_display = ["__str__", "tags_list", "f2z_score"]

    search_fields = [
        "free2zaddr",
        "title",
        "vanity",
        "content",
        "p2paddr",
        "creator__username",
    ]
    autocomplete_fields = ['creator', 'featured_image']
    readonly_fields = ['link', 'p2pqr', 'updated_at', 'created_at']
    fields = [
        'creator',
        'source_language',
        'title',
        'content',
        'category',
        'link',
        'free2zaddr',
        'featured_image',
        # 'free2zqr',
        'password',
        'f2z_score',
        'total',
        'tuzi_total',
        # above is free
        'is_verified',
        'is_published',
        'is_subscriber_only',
        'vanity',
        'p2paddr',
        'p2pqr',
        'goal',
        'created_at',
        'updated_at',
        'publish_at',
        'tags',
    ]

    def get_queryset(self, request):
        return super().get_queryset(request).prefetch_related('tags')

    # `source_language` used to be forced read-only on an existing page here,
    # mirroring the serializer's write-once rule.  §3.2 makes the label
    # mutable everywhere, so the override is gone: staff editing it now goes
    # through the same save path as a creator, which dual-writes the source
    # variant ( M3).

    def link(self, inst):
        return format_html(
            f'<a target="_blank" href="/{inst.vanity or inst.free2zaddr}">show</a>'
        )

    def p2pqr(self, inst):
        return format_html(
            f'<img src="http://chart.apis.google.com/chart?chs=128x128&cht=qr&chl={inst.p2paddr}&choe=UTF-8&chld=H|0">'
        )

    def tags_list(self, obj):
        return u", ".join(o.name for o in obj.tags.all())


@admin.register(ZPageTranslation)
class ZPageTranslationAdmin(admin.ModelAdmin):
    form = ZPageTranslationForm
    list_display = ["zpage", "language", "title", "is_published", "updated_at"]
    list_filter = ["language", "is_published"]
    search_fields = ["zpage__title", "zpage__free2zaddr", "title", "content"]
    autocomplete_fields = ["zpage"]


@admin.register(ZPageVariant)
class ZPageVariantAdmin(admin.ModelAdmin):
    """Read-only window on the table readers resolve out of after  M5.

    Registered for one reason: once ``ZPAGE_VARIANT_READS`` is on, "what does
    the reader actually see" is a question about THIS table, and staff had no
    way to look. Diagnosing a drift report by reading ``ZPageTranslation`` --
    the shape that is no longer authoritative -- is how an incident gets closed
    as "cannot reproduce".

    Deliberately not editable, and the refusal is the safe half of the choice.
    Nothing mirrors a variant edit BACK to the legacy columns, so a staff edit
    here would create exactly the divergence the reconciler exists to remove --
    invisible until it is a wrong page. Staff edit content through
    ``zPage`` / ``ZPageTranslation``, which dual-write mirrors; repairs go
    through ``manage.py reconcile_zpage_variants --repair``.
    """

    list_display = [
        "zpage", "language", "origin", "is_published", "title", "updated_at",
    ]
    list_filter = ["origin", "is_published", "language"]
    search_fields = ["zpage__title", "zpage__free2zaddr", "title", "content"]
    list_select_related = ["zpage"]

    def has_add_permission(self, request: HttpRequest) -> bool:
        return False

    def has_change_permission(self, *args, **kwargs) -> bool:
        return False

    def has_delete_permission(self, *args, **kwargs) -> bool:
        return False


@admin.register(Transaction)
class TransactionAdmin(admin.ModelAdmin):
    search_fields = [
        'txid', 'zpage__title', 'zpage__creator__username',
        'creator__username', 'creator__p2paddr',
        'memo_plain',
    ]
    list_filter = ['action']
    list_display = ['txid', 'amount', 'action', 'creator', 'zpage', 'memo_plain']

    def has_add_permission(self, request: HttpRequest) -> bool:
        return False

    def has_change_permission(self, *args, **kwargs) -> bool:
        return False


@admin.register(Address)
class AddressAdmin(admin.ModelAdmin):
    list_display = ['address', 'created_at', 'is_current']


@admin.register(PageComment)
class PageCommentAdmin(admin.ModelAdmin):
    list_display = ['tx', 'zpage']


class PageOrderInline(admin.TabularInline):
    model = PageOrder
    extra = 1


class SeriesAdmin(admin.ModelAdmin):
    list_display = ('id', 'name', 'creator', 'created_at', 'updated_at')
    inlines = [
        PageOrderInline,
    ]


admin.site.register(Series, SeriesAdmin)


@admin.register(AccountDeletionEvent)
class AccountDeletionEventAdmin(admin.ModelAdmin):
    """Read-only audit trail of self-service account deletion."""

    list_display = ("creator_id", "kind", "at")
    list_filter = ("kind",)
    search_fields = ("creator__id",)
    readonly_fields = ("creator", "kind", "at", "detail")

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
