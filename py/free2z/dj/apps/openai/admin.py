from django.contrib import admin
from .models import AIModel, Conversation, PromptResponse, Personality, ProviderModel


@admin.register(Personality)
class PersonalityAdmin(admin.ModelAdmin):
    list_display = ('id', 'display_name', 'system_message', 'is_public', 'creator')
    list_filter = ('is_public',)
    search_fields = ('display_name', 'system_message', 'creator__username')
    readonly_fields = ('id',)


class AIModelAdmin(admin.ModelAdmin):
    # `is_enabled` is listed and filterable because it is the one column that
    # decides whether user content may reach a vendor at all. An
    # operator answering "are we still sending anything to X?" must be able to
    # see it without opening a row.
    list_display = ('id', 'provider', 'model', 'display_name',
                    'system_message', 'max_tokens', 'max_output_tokens',
                    'max_response_tokens', 'is_ga', 'is_enabled', 'order')
    list_filter = ('provider', 'is_ga', 'is_enabled')
    search_fields = ('model', 'display_name')


@admin.register(ProviderModel)
class ProviderModelAdmin(admin.ModelAdmin):
    """What each keyed provider lists (``discover_ai_models``), read-only.

    ``priced`` answers the owner's question -- "what can this key reach that
    nobody has priced yet?" -- without a query: a listed id with no AIModel
    row whose upstream id matches is sellable only after a lineup + rate-card
    migration.
    """
    list_display = ('provider', 'provider_model_id', 'listed', 'priced',
                    'first_seen_at', 'last_seen_at', 'missing_since')
    list_filter = ('provider',)
    search_fields = ('provider_model_id',)
    ordering = ('provider', 'provider_model_id')
    readonly_fields = ('provider', 'provider_model_id', 'first_seen_at',
                       'last_seen_at', 'missing_since', 'metadata')

    def has_add_permission(self, request):
        return False  # written by discovery only

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        # Deleting a provider's rows would silently reopen its gate (the
        # queryset is fail-open until a snapshot exists). Discovery owns
        # every row; a model the provider withdrew is marked, never removed.
        return False

    @admin.display(boolean=True)
    def listed(self, obj):
        return obj.missing_since is None

    @admin.display(boolean=True)
    def priced(self, obj):
        from django.db.models import Q

        return AIModel.objects.filter(provider=obj.provider).filter(
            Q(provider_model_id=obj.provider_model_id)
            | Q(provider_model_id="", model=obj.provider_model_id)
        ).exists()


class ConversationAdmin(admin.ModelAdmin):
    list_display = ('id', 'display_name', 'ai_model', 'user', 'created_at',
                    'updated_at', 'is_public')
    search_fields = ('id', 'user__username', 'ai_model__display_name', 'display_name')
    list_filter = ('is_public', 'ai_model', 'user')
    autocomplete_fields = ['ai_model', 'user', 'personality', 'prompt_response_set']


class PromptResponseAdmin(admin.ModelAdmin):
    list_display = ('id', 'conversation', 'user_input',
                    'response', 'created_at', 'updated_at')
    search_fields = ('user_input', 'response', 'conversation__id')

    def get_queryset(self, request):
        # Staff see every turn, a deletion-pending author's too:
        # PromptResponse.objects hides those (account deletion grace period).
        return PromptResponse._base_manager.all()


admin.site.register(AIModel, AIModelAdmin)
admin.site.register(Conversation, ConversationAdmin)
admin.site.register(PromptResponse, PromptResponseAdmin)
