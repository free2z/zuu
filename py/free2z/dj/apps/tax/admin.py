from django.contrib import admin
from .models import Currency, TaxEvent, CostBasis


@admin.register(Currency)
class CurrencyAdmin(admin.ModelAdmin):
    list_display = ('code',)
    search_fields = ('code',)


@admin.register(CostBasis)
class CostBasisAdmin(admin.ModelAdmin):
    list_display = (
        'currency', 'quantity', 'total_cost', 'average_cost_basis',
        'last_updated',
    )
    search_fields = ('currency',)
    ordering = ('-last_updated',)


@admin.register(TaxEvent)
class EventAdmin(admin.ModelAdmin):
    list_display = (
        'unique_id',
        'date_time', 'get_type', 'description', 'currency_out', 'amount_out',
        'currency_in', 'amount_in', 'usd_value',
        'gain_loss',
    )
    # list_filter = ('category',)
    search_fields = ('description',)
    date_hierarchy = 'date_time'
    ordering = ('-date_time',)
    fields = (
        'type',
        'date_time', 'description', 'category',
        ('currency_out', 'amount_out'),
        ('currency_in', 'amount_in'),
        'gain_loss',
        'usd_value',
    )
    readonly_fields = ['type', 'gain_loss']

    def get_type(self, obj):
        return obj.get_type()
    get_type.short_description = "Type"
