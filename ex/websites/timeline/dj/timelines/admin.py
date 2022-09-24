from django.contrib import admin

from .models import Timeline, Event, Date, Media


class EventInline(admin.TabularInline):
    model = Timeline.events.through


class DateInline(admin.TabularInline):
    model = Date



@admin.register(Timeline)
class TimelineAdmin(admin.ModelAdmin):
    # autocomplete_fields = ['events']
    readonly_fields = ['slug']

    inlines = [EventInline]
    exclude = ['events']


@admin.register(Event)
class EventAdmin(admin.ModelAdmin):
    search_fields = ['headline', 'text']
    inlines = [DateInline]


# admin.site.register(Date)
# admin.site.register(Media)
