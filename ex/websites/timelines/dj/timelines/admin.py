from django.contrib import admin

from .models import Timeline, Event, Media


class EventInline(admin.TabularInline):
    model = Timeline.events.through


@admin.register(Timeline)
class TimelineAdmin(admin.ModelAdmin):
    # autocomplete_fields = ['events']
    search_fields = ['name']
    readonly_fields = ['slug']
    inlines = [EventInline]
    exclude = ['events']
    autocomplete_fields = ['children', 'media']


@admin.register(Event)
class EventAdmin(admin.ModelAdmin):
    search_fields = ['headline', 'text']


@admin.register(Media)
class MediaAdmin(admin.ModelAdmin):
    search_fields = ['url']
