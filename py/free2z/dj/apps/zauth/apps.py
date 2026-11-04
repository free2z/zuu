from django.apps import AppConfig


class ZauthConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'dj.apps.zauth'
    label = 'zauth'
    verbose_name = 'Login with Zcash'
