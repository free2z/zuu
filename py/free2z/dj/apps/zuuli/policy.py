"""Public ZUULI compatibility contract and version decisions.

The setting is intentionally an allowlisted data structure rather than an
arbitrary dump of Django configuration. This endpoint is public and cached;
only fields explicitly copied by :func:`build_contract` can leave the server.
"""
from copy import deepcopy
import re
from urllib.parse import urlparse

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import URLValidator


SUPPORTED_PLATFORMS = ("ios", "android", "macos", "linux")
CAPABILITY_GROUPS = {
    "auth": ("password", "zcash", "social"),
    "wallet": ("zcash_login", "zec_pricing"),
    "commerce": (
        "two_z_ledger",
        "zec_purchase",
        "storekit",
        "play_billing",
    ),
}
PUBLIC_CONFIG_FIELDS = ("api_base_path", "openapi_path", "zcash_network")
DOWNLOAD_HOSTS = {
    "ios": {"apps.apple.com", "testflight.apple.com"},
    "android": {"play.google.com"},
    "macos": {"apps.apple.com", "github.com", "free2z.cash"},
    "linux": {"github.com", "free2z.cash"},
}

_VERSION_RE = re.compile(
    r"(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\."
    r"(0|[1-9][0-9]{0,8})\Z"
)
_PUBLIC_PATH_RE = re.compile(r"/[A-Za-z0-9._/-]*\Z")


class PolicyConfigurationError(RuntimeError):
    """The deployed ZUULI release policy is invalid."""


class ClientQueryError(ValueError):
    """The caller supplied an invalid platform/version query."""


def parse_version(value):
    """Parse the coordinated three-component app version format."""
    if not isinstance(value, str):
        raise ValueError("version must be a string")
    match = _VERSION_RE.fullmatch(value)
    if match is None:
        raise ValueError("version must use canonical MAJOR.MINOR.PATCH format")
    return tuple(int(part) for part in match.groups())


def _require_mapping(value, path):
    if not isinstance(value, dict):
        raise PolicyConfigurationError(f"{path} must be an object")
    return value


def _require_exact_keys(value, expected, path):
    actual = set(value)
    expected = set(expected)
    if actual != expected:
        raise PolicyConfigurationError(
            f"{path} keys must be {sorted(expected)!r}; got {sorted(actual)!r}"
        )


def _validated_policy():
    raw = deepcopy(settings.ZUULI_RELEASE_POLICY)
    policy = _require_mapping(raw, "ZUULI_RELEASE_POLICY")
    _require_exact_keys(
        policy,
        {
            "contract_version",
            "maintenance",
            "platforms",
            "capabilities",
            "public_config",
            "cache_max_age_seconds",
        },
        "ZUULI_RELEASE_POLICY",
    )

    if type(policy["contract_version"]) is not int or policy["contract_version"] < 1:
        raise PolicyConfigurationError("contract_version must be a positive integer")

    maintenance = _require_mapping(policy["maintenance"], "maintenance")
    _require_exact_keys(maintenance, {"enabled", "message"}, "maintenance")
    if type(maintenance["enabled"]) is not bool:
        raise PolicyConfigurationError("maintenance.enabled must be a boolean")
    if maintenance["message"] is not None and not isinstance(
        maintenance["message"], str
    ):
        raise PolicyConfigurationError("maintenance.message must be a string or null")
    if maintenance["enabled"] and not maintenance["message"]:
        raise PolicyConfigurationError(
            "maintenance.message must be non-empty while maintenance is enabled"
        )

    platforms = _require_mapping(policy["platforms"], "platforms")
    _require_exact_keys(platforms, SUPPORTED_PLATFORMS, "platforms")
    for platform in SUPPORTED_PLATFORMS:
        release = _require_mapping(platforms[platform], f"platforms.{platform}")
        _require_exact_keys(
            release,
            {"minimum_supported", "current_recommended", "download_url"},
            f"platforms.{platform}",
        )
        try:
            minimum = parse_version(release["minimum_supported"])
            recommended = parse_version(release["current_recommended"])
        except ValueError as exc:
            raise PolicyConfigurationError(f"platforms.{platform}: {exc}") from exc
        if recommended < minimum:
            raise PolicyConfigurationError(
                f"platforms.{platform}.current_recommended must not be below "
                "minimum_supported"
            )
        download_url = release["download_url"]
        if download_url is not None:
            if not isinstance(download_url, str):
                raise PolicyConfigurationError(
                    f"platforms.{platform}.download_url must be a public HTTPS "
                    "URL or null"
                )
            try:
                URLValidator(schemes=["https"])(download_url)
                parsed_url = urlparse(download_url)
            except (ValidationError, ValueError) as exc:
                raise PolicyConfigurationError(
                    f"platforms.{platform}.download_url must be a public HTTPS "
                    "URL or null"
                ) from exc
            if (
                parsed_url.username is not None
                or parsed_url.password is not None
                or parsed_url.hostname not in DOWNLOAD_HOSTS[platform]
            ):
                raise PolicyConfigurationError(
                    f"platforms.{platform}.download_url host must be one of "
                    f"{sorted(DOWNLOAD_HOSTS[platform])!r}"
                )
        if minimum > (0, 0, 0) and download_url is None:
            raise PolicyConfigurationError(
                f"platforms.{platform}.download_url is required before "
                "minimum_supported can require an update"
            )
        if recommended > (0, 0, 0) and download_url is None:
            raise PolicyConfigurationError(
                f"platforms.{platform}.download_url is required before "
                "current_recommended can recommend an update"
            )

    capabilities = _require_mapping(policy["capabilities"], "capabilities")
    _require_exact_keys(capabilities, CAPABILITY_GROUPS, "capabilities")
    for group, names in CAPABILITY_GROUPS.items():
        flags = _require_mapping(capabilities[group], f"capabilities.{group}")
        _require_exact_keys(flags, names, f"capabilities.{group}")
        if any(type(flags[name]) is not bool for name in names):
            raise PolicyConfigurationError(
                f"all capabilities.{group} values must be booleans"
            )

    public_config = _require_mapping(policy["public_config"], "public_config")
    _require_exact_keys(public_config, PUBLIC_CONFIG_FIELDS, "public_config")
    for name in ("api_base_path", "openapi_path"):
        path = public_config[name]
        if (
            not isinstance(path, str)
            or _PUBLIC_PATH_RE.fullmatch(path) is None
            or path.startswith("//")
        ):
            raise PolicyConfigurationError(
                f"public_config.{name} must be a safe absolute URL path"
            )
    if public_config["zcash_network"] not in {
        None,
        "mainnet",
        "testnet",
        "regtest",
    }:
        raise PolicyConfigurationError(
            "public_config.zcash_network must be null, mainnet, testnet, or regtest"
        )
    if public_config["zcash_network"] != "mainnet" and (
        capabilities["auth"]["zcash"]
        or capabilities["wallet"]["zcash_login"]
    ):
        raise PolicyConfigurationError(
            "Zcash authentication can be advertised only on mainnet while the "
            "deployed verifier is mainnet-only"
        )

    cache_seconds = policy["cache_max_age_seconds"]
    if type(cache_seconds) is not int or not 0 <= cache_seconds <= 3600:
        raise PolicyConfigurationError(
            "cache_max_age_seconds must be an integer between 0 and 3600"
        )
    return policy


def validate_policy_configuration():
    """Validate the entire policy during application startup."""
    _validated_policy()


def parse_client_query(query_params):
    """Return ``(platform, version)`` or ``(None, None)`` for discovery."""
    unknown = set(query_params) - {"platform", "version"}
    if unknown:
        raise ClientQueryError(
            f"unknown query parameter(s): {', '.join(sorted(unknown))}"
        )
    if len(query_params.getlist("platform")) > 1 or len(
        query_params.getlist("version")
    ) > 1:
        raise ClientQueryError("platform and version may each be supplied once")

    platform = query_params.get("platform")
    version = query_params.get("version")
    if platform is None and version is None:
        return None, None
    if not platform or not version:
        raise ClientQueryError("platform and version must be supplied together")
    if platform not in SUPPORTED_PLATFORMS:
        raise ClientQueryError(
            f"unknown platform; expected one of {', '.join(SUPPORTED_PLATFORMS)}"
        )
    try:
        parse_version(version)
    except ValueError as exc:
        raise ClientQueryError(str(exc)) from exc
    return platform, version


def _client_decision(policy, platform, version):
    release = policy["platforms"][platform]
    parsed = parse_version(version)
    minimum = parse_version(release["minimum_supported"])
    recommended = parse_version(release["current_recommended"])
    update_required = parsed < minimum
    update_recommended = not update_required and parsed < recommended

    if policy["maintenance"]["enabled"]:
        availability = "maintenance"
    elif update_required:
        availability = "update_required"
    else:
        availability = "available"

    return {
        "platform": platform,
        "version": version,
        "supported": not update_required,
        "update_required": update_required,
        "update_recommended": update_recommended,
        "availability": availability,
    }


def build_contract(platform=None, version=None):
    """Build the allowlisted public response for a discovery or client query."""
    policy = _validated_policy()
    client = None
    if platform is not None:
        client = _client_decision(policy, platform, version)

    # Copy every public field individually. Adding a setting cannot publish it
    # accidentally, even if strict validation is later relaxed.
    platforms = {
        name: {
            "minimum_supported": policy["platforms"][name]["minimum_supported"],
            "current_recommended": policy["platforms"][name][
                "current_recommended"
            ],
            "download_url": policy["platforms"][name]["download_url"],
        }
        for name in SUPPORTED_PLATFORMS
    }
    capabilities = {
        group: {
            name: policy["capabilities"][group][name]
            for name in names
        }
        for group, names in CAPABILITY_GROUPS.items()
    }

    # Social login is true only when an operator opted in *and* this running
    # deployment has at least one complete provider credential pair.
    if capabilities["auth"]["social"]:
        from dj.apps.social.clients import configured_mobile_providers

        capabilities["auth"]["social"] = any(
            configured_mobile_providers(enforce_rollout_gate=False).values()
        )

    return {
        "contract_version": policy["contract_version"],
        "service": {
            "maintenance": policy["maintenance"]["enabled"],
            "message": policy["maintenance"]["message"],
        },
        "platforms": platforms,
        "capabilities": capabilities,
        "public_config": {
            "api_base_path": policy["public_config"]["api_base_path"],
            "openapi_path": policy["public_config"]["openapi_path"],
            "zcash_network": policy["public_config"]["zcash_network"],
        },
        "client": client,
    }


def cache_max_age_seconds():
    return _validated_policy()["cache_max_age_seconds"]
