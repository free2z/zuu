from django.apps import AppConfig


class ZuuliConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "dj.apps.zuuli"

    def ready(self):
        # A bad release switch must fail the new pod before it becomes Ready;
        # it must never roll out successfully and then fleet-503 this endpoint.
        from .policy import validate_policy_configuration

        validate_policy_configuration()
