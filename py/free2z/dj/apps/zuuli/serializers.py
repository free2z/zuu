from rest_framework import serializers


class ZuuliMaintenanceSerializer(serializers.Serializer):
    maintenance = serializers.BooleanField()
    message = serializers.CharField(allow_null=True, allow_blank=True)


class ZuuliPlatformReleaseSerializer(serializers.Serializer):
    minimum_supported = serializers.CharField(
        help_text="Oldest app version the backend still supports."
    )
    current_recommended = serializers.CharField(
        help_text="App version users should currently run."
    )
    download_url = serializers.URLField(
        allow_null=True,
        help_text="Verified platform download URL; null before distribution.",
    )


class ZuuliPlatformsSerializer(serializers.Serializer):
    ios = ZuuliPlatformReleaseSerializer()
    android = ZuuliPlatformReleaseSerializer()
    macos = ZuuliPlatformReleaseSerializer()
    linux = ZuuliPlatformReleaseSerializer()


class ZuuliAuthCapabilitiesSerializer(serializers.Serializer):
    password = serializers.BooleanField()
    zcash = serializers.BooleanField()
    social = serializers.BooleanField()


class ZuuliWalletCapabilitiesSerializer(serializers.Serializer):
    zcash_login = serializers.BooleanField()
    zec_pricing = serializers.BooleanField()


class ZuuliCommerceCapabilitiesSerializer(serializers.Serializer):
    two_z_ledger = serializers.BooleanField()
    zec_purchase = serializers.BooleanField()
    storekit = serializers.BooleanField()
    play_billing = serializers.BooleanField()


class ZuuliCapabilitiesFlagsSerializer(serializers.Serializer):
    auth = ZuuliAuthCapabilitiesSerializer()
    wallet = ZuuliWalletCapabilitiesSerializer()
    commerce = ZuuliCommerceCapabilitiesSerializer()


class ZuuliPublicConfigSerializer(serializers.Serializer):
    api_base_path = serializers.CharField()
    openapi_path = serializers.CharField()
    zcash_network = serializers.ChoiceField(
        choices=("mainnet", "testnet", "regtest"), allow_null=True
    )


class ZuuliClientDecisionSerializer(serializers.Serializer):
    platform = serializers.ChoiceField(
        choices=("ios", "android", "macos", "linux")
    )
    version = serializers.CharField()
    supported = serializers.BooleanField()
    update_required = serializers.BooleanField()
    update_recommended = serializers.BooleanField()
    availability = serializers.ChoiceField(
        choices=("available", "maintenance", "update_required")
    )


class ZuuliCapabilitiesSerializer(serializers.Serializer):
    contract_version = serializers.IntegerField(min_value=1)
    service = ZuuliMaintenanceSerializer()
    platforms = ZuuliPlatformsSerializer()
    capabilities = ZuuliCapabilitiesFlagsSerializer()
    public_config = ZuuliPublicConfigSerializer()
    client = ZuuliClientDecisionSerializer(allow_null=True)


class ZuuliErrorSerializer(serializers.Serializer):
    detail = serializers.CharField()
