from django.contrib import admin
from django.db.models import Case, IntegerField, Value, When

from .models import Comment, ContentReport


@admin.register(Comment)
class CommentAdmin(admin.ModelAdmin):
    list_display = ['uuid', 'headline', 'author', 'created_at']
    search_fields = ['headline', 'content']
    readonly_fields = ['created_at', 'updated_at']
    autocomplete_fields = ['author']


@admin.register(ContentReport)
class ContentReportAdmin(admin.ModelAdmin):
    list_display = ['id', 'reason', 'status', 'target_kind', 'target_id', 'created_at']
    list_filter = ['status', 'reason', 'target_kind']
    readonly_fields = ['id', 'reporter', 'target_kind', 'target_id', 'reason',
                       'details', 'created_at']
    search_fields = ['target_id']

    def get_queryset(self, request):
        return super().get_queryset(request).annotate(
            _priority=Case(When(reason='csae', then=Value(0)), default=Value(1),
                           output_field=IntegerField())
        ).order_by('_priority', 'created_at')

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
