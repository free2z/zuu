from django.contrib import admin

from .models import ZecPriceSnapshot


@admin.register(ZecPriceSnapshot)
class ZecPriceSnapshotAdmin(admin.ModelAdmin):
    list_display = (
        'created_at', 'zec_usd', 'median_usd', 'spread',
        'tuzis_per_zec', 'num_sources',
    )
    readonly_fields = tuple(f.name for f in ZecPriceSnapshot._meta.fields)
    list_filter = ('created_at',)

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False
