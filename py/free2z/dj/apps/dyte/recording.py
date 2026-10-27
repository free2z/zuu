"""Validation for provider-supplied recording download URLs.

The recording pipeline fetches a `downloadUrl` that ORIGINATES from the
webhook payload. Even after the webhook signature is verified — proving the
message really came from the provider — the URL inside it is still
provider-relayed data, not something we chose. The `dyte_download_upload`
subscriber then does `requests.get(url)` from inside the cluster and stores
the bytes as a file owned by a creator, so an unconstrained fetch is an SSRF +
file-injection primitive. This module is the allowlist that closes it.

`settings.DYTE_RECORDING_ALLOWED_HOSTS` is the list of permitted host
suffixes. The default covers where RealtimeKit/Dyte actually stores
recordings (S3 presigned URLs — see `DyteClient.create_meeting`'s
`storage_config` and the `*.amazonaws.com` entry already in the app CSP) plus
the provider's own domains and Cloudflare R2 for the post-migration path. It
is overridable via the `DYTE_RECORDING_ALLOWED_HOSTS` env var (comma
separated) so ops can adjust it WITHOUT a code deploy if the provider changes
storage — important, because getting it wrong stops recordings, and recordings
must keep working.
"""
import ipaddress
import re
from urllib.parse import urlsplit, urlunsplit


_SAFE_PROVIDER_HOST_LABELS = frozenset({
    'api', 'cdn', 'r2', 'realtime', 's3', 'storage',
})
_SAFE_REGION_LABEL_RE = re.compile(
    r'^(?:[a-z]{2,3}-[a-z]+-\d+|s3-[a-z0-9-]+)$',
)
_SUSPICIOUS_HOST_LABEL_RE = re.compile(
    r'(?i)(?:bearer|capabilit|credential|presign|secret|signature|token)',
)
# Length backstop for the keyword list above, which can only catch a label that
# names itself. A capability smuggled in a DNS label has to carry enough
# entropy to be unguessable, so it is long; the registrable names an operator
# actually needs to read out of a rejection log are not (`amazonaws` is 9,
# `cloudflarestorage` 17). Anything past this is redacted regardless of shape.
_MAX_RETAINED_LABEL_LENGTH = 24


def _normalized_host(hostname):
    hostname = str(hostname).rstrip('.').lower()
    if ':' in hostname:
        return hostname
    try:
        return hostname.encode('idna').decode('ascii')
    except UnicodeError:
        return hostname


def _is_capability_shaped_label(label):
    return (
        len(label) > _MAX_RETAINED_LABEL_LENGTH
        or bool(_SUSPICIOUS_HOST_LABEL_RE.search(label))
    )


def _safe_host_context(hostname, matched_suffix):
    """Keep useful origin context while hiding provider-controlled labels."""
    hostname = _normalized_host(hostname)
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
    if address is not None:
        return (
            f'[{address.compressed}]'
            if address.version == 6 else address.compressed
        )

    labels = hostname.split('.')
    if matched_suffix:
        suffix_labels = matched_suffix.split('.')
        prefix = labels[:-len(suffix_labels)]
        safe_prefix = [
            label if (
                (
                    label in _SAFE_PROVIDER_HOST_LABELS
                    or _SAFE_REGION_LABEL_RE.fullmatch(label)
                )
                # `s3-<anything>` matches the region shape, so the length
                # backstop still applies: a real region is `s3-us-east-1`, not
                # `s3-<40 characters of base64>`.
                and not _is_capability_shaped_label(label)
            ) else '<redacted>'
            for label in prefix
        ]
        return '.'.join(safe_prefix + suffix_labels)

    # For an unrecognized DNS name, retain the registrable-looking tail so a
    # rejection or redirect still tells an operator which destination is
    # involved. Any subdomain (where provider capabilities commonly live) is
    # represented by a marker, and a leftmost label that either names itself as
    # a credential or is too long to be a real registrable name is redacted
    # too — a two-label host is the one place a capability could otherwise
    # survive into the log.
    if len(labels) == 1:
        return '<redacted>'
    if len(labels) == 2 and _is_capability_shaped_label(labels[0]):
        return f'<redacted>.{labels[-1]}'
    tail = labels[-2:]
    return '.'.join((['<redacted>'] if len(labels) > 2 else []) + tail)


def redact_recording_url(url, allowed_hosts) -> str:
    """Render a credential-free, useful origin for a recording URL.

    Presigned query parameters are live download credentials, userinfo can
    carry credentials, and some capability-URL providers put bearer tokens in
    paths or provider-controlled subdomain labels. Rebuild only the scheme and
    a safe host context: the configured suffix is trusted, known service/region
    labels are retained, and provider-controlled labels are replaced. For an
    unrecognized host, preserve an IP or domain tail so rejection and redirect
    logs remain actionable without copying the complete hostname.
    """
    try:
        parsed = urlsplit(str(url))
        raw_hostname = parsed.hostname
        if not parsed.scheme or not raw_hostname:
            return "<invalid recording url>"
        hostname = _normalized_host(raw_hostname)

        # Accessing ``port`` is deliberately inside the try because urlsplit
        # parses it lazily and can raise for a malformed/out-of-range value.
        port = parsed.port
        normalized_suffixes = {
            str(suffix).strip().lower().lstrip(".")
            for suffix in (allowed_hosts or ())
            if str(suffix).strip().strip(".")
        }
        matches = [
            suffix for suffix in normalized_suffixes
            if hostname == suffix or hostname.endswith("." + suffix)
        ]
        matched_suffix = max(matches, key=len) if matches else ''
        safe_host = _safe_host_context(hostname, matched_suffix)
        authority = safe_host
        if port is not None:
            authority = f"{authority}:{port}"
        return urlunsplit((parsed.scheme, authority, "", "", ""))
    except Exception:
        # Logging must never turn a malformed provider value into a webhook
        # failure; urlsplit also performs some validation lazily.
        return "<unparseable recording url>"


def is_allowed_recording_url(url, allowed_hosts) -> bool:
    """True iff `url` is an https URL whose host is within `allowed_hosts`.

    `allowed_hosts` is an iterable of host suffixes, e.g. ``"amazonaws.com"``.
    A candidate host matches a suffix when it equals it or ends with
    ``"." + suffix`` — so ``amazonaws.com`` permits
    ``my-bucket.s3.us-east-1.amazonaws.com`` but NOT
    ``amazonaws.com.evil.example`` (which would only match a suffix of
    ``evil.example``). Matching is host-only and case-insensitive; the path,
    query and any credentials are irrelevant to the decision.
    """
    if not url or not isinstance(url, str):
        return False

    try:
        parsed = urlsplit(url)
    except (ValueError, TypeError):
        return False

    # https only. http would allow cleartext interception and, more to the
    # point, sidesteps the transport the provider actually uses.
    if parsed.scheme != "https":
        return False

    # `hostname` is already lowercased by urlparse and strips any userinfo and
    #port, so it cannot be spoofed with `user@evil` or `host:80@real`.
    host = parsed.hostname
    if not host:
        return False

    for suffix in allowed_hosts:
        if not suffix:
            continue
        suffix = suffix.strip().lower().lstrip(".")
        if not suffix:
            continue
        if host == suffix or host.endswith("." + suffix):
            return True
    return False
