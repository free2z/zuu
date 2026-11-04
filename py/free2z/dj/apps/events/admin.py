from django.contrib import admin

from .models import Event


@admin.register(Event)
class EventAdmin(admin.ModelAdmin):
    list_display = [
        'id',
        'type',
        'amount',
        'receiving_user',
        'contributor',
        'payee',
    ]
    list_filter = ['type']
    search_fields = [
        'type',
        'receiving_user__username',
        'contributor__username',
        'payee__username',
    ]
