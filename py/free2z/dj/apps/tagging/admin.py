from django.http import HttpResponseRedirect
from django.contrib import admin, messages

from taggit.models import Tag

from dj.apps.openai.models import combine_tags
from .forms import CombineTagsForm

admin.site.unregister(Tag)


@admin.register(Tag)
class TaggitAdmin(admin.ModelAdmin):
    # change_list_template = 'admin/taggit/change_list.html'

    search_fields = ('name',)
    list_display = ('name', 'slug',)
    ordering = ('name',)

    def changelist_view(self, request, extra_context=None):
        extra_context = extra_context or {}
        if request.method == 'POST':
            form = CombineTagsForm(request.POST)
            if form.is_valid():
                combine_tags(
                    form.cleaned_data['preferred'],
                    form.cleaned_data['redundant'],
                )
                messages.success(request, f"combined {form.cleaned_data['redundant']} into {form.cleaned_data['preferred']}")
                return HttpResponseRedirect(request.get_full_path())
        else:
            form = CombineTagsForm()

        extra_context['combine_tags_form'] = form
        return super().changelist_view(request, extra_context=extra_context)


# ---------------------------------------------------------------------------
# AI tag suggestions. Read-mostly: the creator decides through the
# editor, and an admin overriding that would be exactly the silent write this
# work removed. What an operator actually needs from here is visibility --
# what was proposed, on which model, and what people did with it -- so this is
# a listing with filters, not an editing surface.
# ---------------------------------------------------------------------------

from .models import TagSuggestion, TagSuggestionRun  # noqa: E402


@admin.register(TagSuggestion)
class TagSuggestionAdmin(admin.ModelAdmin):
    list_display = ('name', 'zpage', 'status', 'ai_model', 'created_at',
                    'decided_at')
    list_filter = ('status', 'ai_model', 'created_at')
    search_fields = ('name', 'name_key', 'zpage__free2zaddr', 'zpage__title')
    raw_id_fields = ('zpage', 'decided_by')
    readonly_fields = ('name_key', 'source_digest', 'created_at', 'decided_at')
    date_hierarchy = 'created_at'


@admin.register(TagSuggestionRun)
class TagSuggestionRunAdmin(admin.ModelAdmin):
    list_display = ('zpage', 'ai_model', 'proposed_count', 'created_at')
    list_filter = ('ai_model', 'created_at')
    search_fields = ('zpage__free2zaddr', 'zpage__title', 'source_digest')
    raw_id_fields = ('zpage',)
    readonly_fields = ('source_digest', 'created_at')
    date_hierarchy = 'created_at'
