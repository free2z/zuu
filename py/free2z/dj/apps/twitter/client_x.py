"""Minimal X API v2 client for @F2ZP2P announcements.

Two calls, both OAuth 1.0a user context with the app's existing
``TWITTER_API_KEY`` / ``TWITTER_API_KEY_SECRET`` (consumer) and
``TWITTER_ACCESS_KEY`` / ``TWITTER_ACCESS_KEY_SECRET`` (the @F2ZP2P access
token) -- the same four the legacy ``twatter.twat`` used, so no new secret:

* ``POST https://api.x.com/2/media/upload`` -- one-shot image upload,
  ``multipart/form-data`` with ``media`` (raw bytes) and
  ``media_category=tweet_image``. Documented at
  https://docs.x.com/x-api/media/upload-media as accepting OAuth 1.0a
  ("UserToken") as well as OAuth 2 with ``media.write``; the response is
  ``{"data": {"id", "media_key", "expires_after_secs",...}}``. The legacy
  ``upload.twitter.com/1.1/media/upload.json`` is not used.
* ``POST https://api.x.com/2/tweets`` -- ``{"text", "media": {"media_ids"}}``;
  ``201 {"data": {"id", "text"}}``.

EVERY FAILURE IS CLASSIFIED, because the caller's policy depends on it and
the old client raised a bare ``Exception`` for all of them:

``RETRYABLE``   nothing was created: 429, a timed-out CONNECT (and, for the
                media upload only, 503 / 5xx / any transport error).
``AUTH``        401 / 402 (``credits-depleted``) / 403 -- page an operator,
                do not hammer.
``INVALID``     4xx that a retry cannot fix (400, 403 duplicate content, 413).
``AMBIGUOUS``   the create request may have reached X: read timeout,
                connection dropped mid-request, ANY 5xx including 503 (X
                documents 503 as overload, not as "nothing happened"). X offers no
                idempotency key for ``POST /2/tweets``, so the caller must
                reconcile, never blindly retry.

For the media upload an "ambiguous" outcome is harmless (an orphaned media
id posts nothing), so:func:`upload_image` reports it as ``RETRYABLE``.

Every request carries an explicit ``timeout`` ( guard,
``jobs/test_no_unbounded_http_in_tasks.py`` scans ``client*.py``).
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass

import requests
from requests_oauthlib import OAuth1

API_BASE = "https://api.x.com"
MEDIA_UPLOAD_URL = f"{API_BASE}/2/media/upload"
CREATE_POST_URL = f"{API_BASE}/2/tweets"

#(connect, read) seconds.
UPLOAD_TIMEOUT = (5, 20)
CREATE_TIMEOUT = (5, 20)

#X's one-shot image limit.
MAX_IMAGE_BYTES = 5 * 1024 * 1024

RETRYABLE = "retryable"
AUTH = "auth"
INVALID = "invalid"
AMBIGUOUS = "ambiguous"

_CREDENTIAL_ENV = (
    "TWITTER_API_KEY",
    "TWITTER_API_KEY_SECRET",
    "TWITTER_ACCESS_KEY",
    "TWITTER_ACCESS_KEY_SECRET",
)


class XNotConfigured(RuntimeError):
    """One of the four OAuth 1.0a credentials is missing."""


class XProviderError(Exception):
    def __init__(self, kind, message, *, status=None, problem="",
                 retry_after=None):
        super().__init__(message)
        self.kind = kind
        self.status = status
        self.problem = problem
        #seconds, when X said how long to wait (429 reset headers)
        self.retry_after = retry_after


@dataclass(frozen=True)
class UploadedMedia:
    media_id: str
    expires_after_secs: int | None


def _auth():
    values = [os.environ.get(name, "") for name in _CREDENTIAL_ENV]
    missing = [n for n, v in zip(_CREDENTIAL_ENV, values) if not v]
    if missing:
        raise XNotConfigured(
            "X credentials not configured: " + ", ".join(missing)
        )
    return OAuth1(
        values[0],
        client_secret=values[1],
        resource_owner_key=values[2],
        resource_owner_secret=values[3],
    )


def _problem(response):
    """(problem type, short detail) from an X error body, never raising."""
    try:
        body = response.json()
    except ValueError:
        return "", (response.text or "")[:300]
    if not isinstance(body, dict):
        return "", str(body)[:300]
    problem = str(body.get("type") or "")
    detail = str(body.get("detail") or body.get("title") or "")
    errors = body.get("errors")
    if not detail and isinstance(errors, list) and errors:
        first = errors[0] if isinstance(errors[0], dict) else {}
        detail = str(first.get("message") or first.get("detail") or "")
        problem = problem or str(first.get("type") or "")
    return problem, detail[:300]


def _retry_after(response):
    """Seconds to wait, from ``retry-after`` or ``x-rate-limit-reset``."""
    raw = response.headers.get("retry-after")
    if raw and raw.strip().isdigit():
        return int(raw.strip())
    reset = response.headers.get("x-rate-limit-reset")
    if reset and reset.strip().isdigit():
        return max(0, int(reset.strip()) - int(time.time()))
    return None


def classify_status(response, *, create):
    """Map a non-success response to an:class:`XProviderError`."""
    status = response.status_code
    problem, detail = _problem(response)
    message = f"X {status}: {detail or problem or 'no detail'}"
    if status == 429:
        return XProviderError(
            RETRYABLE, message, status=status, problem=problem,
            retry_after=_retry_after(response),
        )
    if status == 403 and "duplicate" in (detail + problem).lower():
        return XProviderError(INVALID, message, status=status, problem=problem)
    if status in (401, 402, 403):
        return XProviderError(AUTH, message, status=status, problem=problem)
    if status >= 500:
        # A server/gateway error on a create can hide an accepted post; X
        # gives no no-side-effect guarantee even for 503 (codex review).
        kind = AMBIGUOUS if create else RETRYABLE
        return XProviderError(
            kind, message, status=status, problem=problem,
            retry_after=_retry_after(response),
        )
    return XProviderError(INVALID, message, status=status, problem=problem)


def upload_image(data: bytes, mime_type: str) -> UploadedMedia:
    if not data:
        raise XProviderError(INVALID, "empty image")
    if len(data) > MAX_IMAGE_BYTES:
        raise XProviderError(INVALID, f"image is {len(data)} bytes")
    auth = _auth()
    try:
        response = requests.post(
            MEDIA_UPLOAD_URL,
            auth=auth,
            files={"media": ("announcement", data, mime_type)},
            data={"media_category": "tweet_image"},
            timeout=UPLOAD_TIMEOUT,
        )
    except requests.RequestException as exc:
        # An upload that may or may not have landed only orphans a media id.
        raise XProviderError(RETRYABLE, f"media upload: {exc!r}") from exc
    if response.status_code not in (200, 201, 202):
        raise classify_status(response, create=False)
    try:
        data_obj = response.json().get("data") or {}
        media_id = str(data_obj["id"])
    except (ValueError, KeyError, AttributeError, TypeError) as exc:
        raise XProviderError(
            RETRYABLE, f"media upload: unparseable response {exc!r}",
            status=response.status_code,
        ) from exc
    expires = data_obj.get("expires_after_secs")
    return UploadedMedia(
        media_id=media_id,
        expires_after_secs=int(expires) if isinstance(expires, int) else None,
    )


def create_post(text: str, media_ids=()) -> str:
    """Create one post and return its id. See module docstring for errors."""
    payload = {"text": text}
    if media_ids:
        payload["media"] = {"media_ids": [str(m) for m in media_ids]}
    auth = _auth()
    try:
        response = requests.post(
            CREATE_POST_URL, auth=auth, json=payload, timeout=CREATE_TIMEOUT,
        )
    except requests.exceptions.ConnectTimeout as exc:
        # No connection was ever established: nothing was sent.
        raise XProviderError(RETRYABLE, f"create: {exc!r}") from exc
    except requests.exceptions.ConnectionError as exc:
        # Covers both "connection refused" (nothing sent) and "connection
        # reset after the body went out" (maybe created). requests does not
        # distinguish them reliably, so treat as ambiguous -- the safe side
        # for a public, non-idempotent effect.
        raise XProviderError(AMBIGUOUS, f"create: {exc!r}") from exc
    except requests.RequestException as exc:
        # ReadTimeout and friends: the request was sent.
        raise XProviderError(AMBIGUOUS, f"create: {exc!r}") from exc
    if response.status_code != 201:
        if 200 <= response.status_code < 300:
            # A 2xx that is not the documented 201 may still be a created
            # post; do not guess.
            raise XProviderError(
                AMBIGUOUS, f"create: unexpected {response.status_code}",
                status=response.status_code,
            )
        raise classify_status(response, create=True)
    try:
        return str(response.json()["data"]["id"])
    except (ValueError, KeyError, TypeError) as exc:
        raise XProviderError(
            AMBIGUOUS, f"create: 201 without a post id {exc!r}",
            status=201,
        ) from exc


ME_URL = f"{API_BASE}/2/users/me"


def verify_credentials() -> dict:
    """``GET /2/users/me``: which account the configured token posts as.

    Used by ``manage.py f2zp2p check`` before anyone flips the kill switch.
    Returns ``{"id", "username", "name"}``; raises ``XProviderError``.
    """
    auth = _auth()
    try:
        response = requests.get(ME_URL, auth=auth, timeout=CREATE_TIMEOUT)
    except requests.RequestException as exc:
        raise XProviderError(RETRYABLE, f"users/me: {exc!r}") from exc
    if response.status_code != 200:
        raise classify_status(response, create=False)
    try:
        return dict(response.json()["data"])
    except (ValueError, KeyError, TypeError) as exc:
        raise XProviderError(
            INVALID, f"users/me: unparseable {exc!r}",
            status=response.status_code,
        ) from exc
