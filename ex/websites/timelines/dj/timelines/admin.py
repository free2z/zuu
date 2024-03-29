from django.contrib import admin

from .models import Timeline, Event


class EventInline(admin.StackedInline):
    model = Event
    extra = 1
    # classes = ["collapse open"]
    # inline_classes = ["collapse"]
    classes = ('grp-collapse grp-open',)
    inline_classes = ('grp-collapse grp-closed',)


@admin.register(Timeline)
class TimelineAdmin(admin.ModelAdmin):
    # autocomplete_fields = ['events']
    search_fields = ['name']
    readonly_fields = ['slug']
    inlines = [EventInline]
    exclude = ['events']
    autocomplete_fields = ['children']


@admin.register(Event)
class EventAdmin(admin.ModelAdmin):
    search_fields = ['headline', 'text']

