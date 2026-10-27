from django.contrib import admin
from .models import ZecPromotion


@admin.register(ZecPromotion)
class ZecPromotionAdmin(admin.ModelAdmin):
    list_display = ('title', 'code', 'multiplier', 'enabled', 'starts_at', 'ends_at')
    list_filter = ('enabled',)
    search_fields = ('title', 'code')
