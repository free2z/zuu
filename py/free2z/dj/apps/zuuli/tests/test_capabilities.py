from copy import deepcopy
import json
import os
import subprocess
import sys

import pytest
from django.apps import apps
from django.core.exceptions import ImproperlyConfigured
from rest_framework.test import APIClient

from dj.apps.zuuli.apps import ZuuliConfig
from dj.apps.zuuli.policy import (
    PolicyConfigurationError,
    build_contract,
    validate_policy_configuration,
)
from dj.apps.zuuli.serializers import ZuuliCapabilitiesSerializer
from dj.free2z.settings import (
    ZUULI_RELEASE_POLICY,
    _boolean_env,
    _choice_env,
    _strict_boolean_env,
)


@pytest.fixture
def api_client():
    return APIClient()


@pytest.fixture
def policy(settings):
    value = deepcopy(ZUULI_RELEASE_POLICY)
    settings.ZUULI_RELEASE_POLICY = value
    return value


DOWNLOAD_URLS = {
    "ios": "https://testflight.apple.com/join/example",
    "android": "https://play.google.com/store/apps/details?id=cash.free2z.zuuli",
    "macos": "https://github.com/free2z/zuuli/releases/latest",
    "linux": "https://github.com/free2z/zuuli/releases/latest",
}


def test_discovery_contract_is_public_cacheable_and_schema_valid(api_client):
    response = api_client.get(
        "/api/zuuli/capabilities/",
        HTTP_AUTHORIZATION="Bearer definitely-not-a-token",
    )

    assert response.status_code == 200
    assert response["Cache-Control"] == (
        "public, max-age=300, s-maxage=300, proxy-revalidate"
    )
    assert "Set-Cookie" not in response
    payload = response.json()
    assert payload["contract_version"] == 1
    assert payload["client"] is None
    assert list(payload["platforms"]) == ["ios", "android", "macos", "linux"]
    assert payload["capabilities"]["auth"]["social"] is False
    assert payload["capabilities"]["auth"]["zcash"] is False
    assert payload["capabilities"]["wallet"]["zcash_login"] is False
    assert payload["capabilities"]["commerce"]["zec_purchase"] is False
    assert payload["public_config"]["zcash_network"] is None
    assert all(
        release["download_url"] is None
        for release in payload["platforms"].values()
    )
    serializer = ZuuliCapabilitiesSerializer(data=payload)
    assert serializer.is_valid(), serializer.errors


@pytest.mark.parametrize("platform", ["ios", "android", "macos", "linux"])
def test_each_platform_uses_its_own_version_policy(api_client, policy, platform):
    policy["platforms"][platform] = {
        "minimum_supported": "2.3.4",
        "current_recommended": "3.0.0",
        "download_url": DOWNLOAD_URLS[platform],
    }

    required = api_client.get(
        f"/api/zuuli/capabilities/?platform={platform}&version=2.3.3"
    ).json()["client"]
    recommended = api_client.get(
        f"/api/zuuli/capabilities/?platform={platform}&version=2.9.9"
    ).json()["client"]
    current = api_client.get(
        f"/api/zuuli/capabilities/?platform={platform}&version=3.0.0"
    ).json()["client"]
    future = api_client.get(
        f"/api/zuuli/capabilities/?platform={platform}&version=4.0.0"
    ).json()["client"]

    uncached = api_client.get(
        f"/api/zuuli/capabilities/?platform={platform}&version=3.0.0"
    )
    assert uncached["Cache-Control"] == "no-store"

    assert required == {
        "platform": platform,
        "version": "2.3.3",
        "supported": False,
        "update_required": True,
        "update_recommended": False,
        "availability": "update_required",
    }
    assert recommended["supported"] is True
    assert recommended["update_required"] is False
    assert recommended["update_recommended"] is True
    assert recommended["availability"] == "available"
    assert current["update_recommended"] is False
    assert future["update_recommended"] is False


def test_maintenance_is_independent_of_version_compatibility(api_client, policy):
    policy["maintenance"] = {
        "enabled": True,
        "message": "ZUULI is temporarily unavailable.",
    }
    policy["platforms"]["ios"] = {
        "minimum_supported": "1.0.0",
        "current_recommended": "1.0.0",
        "download_url": DOWNLOAD_URLS["ios"],
    }

    response = api_client.get(
        "/api/zuuli/capabilities/?platform=ios&version=0.1.0"
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["service"] == {
        "maintenance": True,
        "message": "ZUULI is temporarily unavailable.",
    }
    assert payload["client"]["supported"] is False
    assert payload["client"]["update_required"] is True
    assert payload["client"]["availability"] == "maintenance"
    assert payload["platforms"]["ios"]["download_url"].startswith("https://")
    assert response["Cache-Control"] == "no-store"


def test_html_accept_header_still_gets_json_and_cannot_poison_cache(api_client):
    response = api_client.get(
        "/api/zuuli/capabilities/", HTTP_ACCEPT="text/html"
    )

    assert response.status_code == 200
    assert response["Content-Type"].startswith("application/json")
    vary = {value.strip() for value in response.get("Vary", "").split(",")}
    assert "Accept" not in vary
    assert "Cookie" not in vary


@pytest.mark.parametrize(
    "query",
    [
        "platform=windows&version=0.1.0",
        "platform=IOS&version=0.1.0",
        "platform=ios",
        "version=0.1.0",
        "platform=ios&version=1.2",
        "platform=ios&version=01.2.3",
        "platform=ios&version=1.2.3-beta",
        f"platform=ios&version={'9' * 10000}.2.3",
        "platform=ios&version=1.2.3&extra=true",
        "platform=ios&platform=android&version=1.2.3",
    ],
)
def test_malformed_or_unknown_clients_are_rejected_without_caching(
    api_client, query
):
    response = api_client.get(f"/api/zuuli/capabilities/?{query}")
    assert response.status_code == 400
    assert response["Cache-Control"] == "no-store"
    assert set(response.json()) == {"detail"}


def test_only_allowlisted_public_configuration_is_returned(policy):
    policy["private_internal_token"] = "never publish me"

    with pytest.raises(
        PolicyConfigurationError, match="ZUULI_RELEASE_POLICY keys"
    ):
        build_contract()


def test_bad_server_policy_fails_closed(api_client, policy):
    policy["platforms"]["ios"]["minimum_supported"] = "not-a-version"

    response = api_client.get(
        "/api/zuuli/capabilities/?platform=ios&version=0.1.0"
    )
    assert response.status_code == 503
    assert response["Cache-Control"] == "no-store"
    assert response.json() == {
        "detail": "Release policy temporarily unavailable."
    }


def test_mandatory_update_requires_a_download_url(api_client, policy):
    policy["platforms"]["ios"]["minimum_supported"] = "0.1.0"

    response = api_client.get("/api/zuuli/capabilities/")

    assert response.status_code == 503
    assert response["Cache-Control"] == "no-store"


@pytest.mark.parametrize(
    "url",
    [
        "https://downloads.example:notaport/app",
        "https://[::1",
        "https://127.0.0.1/app",
        "https://downloads.example/app",
    ],
)
def test_download_url_uses_the_same_strict_public_validator_at_startup(
    policy, url
):
    policy["platforms"]["ios"]["download_url"] = url

    with pytest.raises(PolicyConfigurationError, match="download_url"):
        validate_policy_configuration()


def test_installed_app_runs_zuuli_startup_validation(policy):
    config = apps.get_app_config("zuuli")
    assert isinstance(config, ZuuliConfig)
    policy["platforms"]["ios"]["minimum_supported"] = "not-a-version"

    with pytest.raises(PolicyConfigurationError, match="platforms.ios"):
        config.ready()


def test_verified_mainnet_can_enable_zcash_login(
    api_client, policy
):
    policy["capabilities"]["auth"]["zcash"] = True
    policy["capabilities"]["wallet"]["zcash_login"] = True
    policy["public_config"]["zcash_network"] = "mainnet"

    response = api_client.get("/api/zuuli/capabilities/")
    assert response.status_code == 200
    payload = response.json()
    assert payload["capabilities"]["auth"]["zcash"] is True
    assert payload["capabilities"]["wallet"]["zcash_login"] is True
    assert payload["public_config"]["zcash_network"] == "mainnet"


def test_testnet_cannot_claim_mainnet_only_login(api_client, policy):
    policy["capabilities"]["auth"]["zcash"] = True
    policy["public_config"]["zcash_network"] = "testnet"

    response = api_client.get("/api/zuuli/capabilities/")

    assert response.status_code == 503


def test_social_capability_requires_opt_in_and_live_credentials(
    api_client, policy, settings
):
    policy["capabilities"]["auth"]["social"] = True
    for provider in ("TWITTER", "GOOGLE", "GITHUB"):
        setattr(settings, f"{provider}_CLIENT_ID", "")
        setattr(settings, f"{provider}_CLIENT_SECRET", "")
    assert (
        api_client.get("/api/zuuli/capabilities/").json()["capabilities"]
        ["auth"]["social"]
        is False
    )

    settings.GOOGLE_CLIENT_ID = "client-id"
    settings.GOOGLE_CLIENT_SECRET = "client-secret"
    assert (
        api_client.get("/api/zuuli/capabilities/").json()["capabilities"]
        ["auth"]["social"]
        is False
    )

    settings.ZUULI_MOBILE_OAUTH_PROVIDER_REDIRECT_URI = (
        "https://free2z.cash/api/auth/social/mobile/callback"
    )
    assert (
        api_client.get("/api/zuuli/capabilities/").json()["capabilities"]
        ["auth"]["social"]
        is True
    )


@pytest.mark.parametrize("raw", ["1", "true", "YES", "on"])
def test_boolean_feature_switch_accepts_explicit_true(monkeypatch, raw):
    monkeypatch.setenv("_ZUULI_TEST_SWITCH", raw)
    assert _boolean_env("_ZUULI_TEST_SWITCH") is True


def test_malformed_boolean_feature_switch_fails_disabled(
    monkeypatch, capsys
):
    monkeypatch.setenv("_ZUULI_TEST_SWITCH", "perhaps")
    assert _boolean_env("_ZUULI_TEST_SWITCH") is False
    assert "is not a boolean" in capsys.readouterr().err


def test_operational_switch_rejects_malformed_value(monkeypatch):
    monkeypatch.setenv("_ZUULI_TEST_SWITCH", "perhaps")
    with pytest.raises(ImproperlyConfigured, match="must be a boolean"):
        _strict_boolean_env("_ZUULI_TEST_SWITCH")


def test_network_env_is_trimmed_validated_and_bounded(monkeypatch):
    monkeypatch.setenv("_ZUULI_TEST_NETWORK", " MAINNET\n")
    assert _choice_env(
        "_ZUULI_TEST_NETWORK", {"mainnet", "testnet", "regtest"}
    ) == "mainnet"

    monkeypatch.setenv("_ZUULI_TEST_NETWORK", "main")
    with pytest.raises(ImproperlyConfigured, match="must be one of"):
        _choice_env(
            "_ZUULI_TEST_NETWORK", {"mainnet", "testnet", "regtest"}
        )

    monkeypatch.setenv("_ZUULI_TEST_NETWORK", "unset")
    assert (
        _choice_env(
            "_ZUULI_TEST_NETWORK", {"mainnet", "testnet", "regtest"}
        )
        is None
    )


def test_real_deployment_environment_wires_the_policy():
    env = os.environ.copy()
    env.update(
        {
            "ZUULI_MAINTENANCE_ENABLED": "true",
            "ZUULI_SOCIAL_AUTH_ENABLED": "true",
            "ZUULI_ZCASH_NETWORK": "mainnet",
            # This has deliberately ceased to be an assertion source.
            "ZUULI_ZEC_PURCHASE_ENABLED": "true",
        }
    )
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import json; from dj.free2z.settings import "
                "ZUULI_RELEASE_POLICY as p; print(json.dumps(p))"
            ),
        ],
        check=True,
        capture_output=True,
        text=True,
        env=env,
    )
    deployed = json.loads(result.stdout)

    assert deployed["maintenance"] == {
        "enabled": True,
        "message": "ZUULI is temporarily unavailable.",
    }
    assert deployed["capabilities"]["auth"]["social"] is True
    assert deployed["capabilities"]["auth"]["zcash"] is True
    assert deployed["capabilities"]["wallet"]["zcash_login"] is True
    assert deployed["capabilities"]["commerce"]["zec_purchase"] is False
    assert deployed["public_config"]["zcash_network"] == "mainnet"


