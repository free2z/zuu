from django.contrib import admin

from .models import GenericFile, Webp


@admin.register(GenericFile)
class GenericFileAdmin(admin.ModelAdmin):
    autocomplete_fields = ['owner']
    search_fields = [
        'file', 'title', 'description', 'owner__username'
    ]
    list_filter = ['access', 'mime_type']
    def get_readonly_fields(self, request, obj=None):
        """
        Keep the change form usable on rows that predate the  allowlist —
        which are exactly the rows an admin needs to reach in order to
        remediate them.

        Two separate things blocked it, and fixing only one is useless:

          * `file` carries a FileExtensionValidator, which on a change form
            runs against the value already stored, so a legacy `.svg` row
            could not be saved at all.
          * `mime_type` no longer lists `image/svg+xml` in its choices, so the
            same form fails with "Select a valid choice" even when `file` is
            read-only. (Adversarial review caught this one by actually
            building the modelform — the first fix alone still 400'd.)

        Both are derived from the uploaded bytes and neither should ever be
        hand-edited, so both go read-only on change. The name and recorded
        type stay visible for triage, and flipping `access` to private now
        works on any legacy row. Still editable on add, where a real file is
        being uploaded and the validator is doing its job.
        """
        readonly = super().get_readonly_fields(request, obj)
        if obj is None:
            return readonly
        return [*readonly, 'file', 'mime_type']


@admin.register(Webp)
class ThumbnailAdmin(admin.ModelAdmin):
    autocomplete_fields = ['parent']
    search_fields = [
        'file', 'parent__title', 'parent__description',
        'parent__owner__username',
    ]
