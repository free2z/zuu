"""
import os
from dj.apps.dyte.client import DyteClient

c = Creator.objects.get(username="skylar")
dc = DyteClient(os.environ['DYTE_ORG'])
dc.get_participants_count(c.livestream.meeting_id)

"""
import re
import uuid
import requests
from requests.auth import HTTPBasicAuth

from django.conf import settings

from dj.apps.g12f.branding import default_logo_url
from dj.apps.g12f.models import Creator
from .models import CreatorMeeting

import logging

logger = logging.getLogger(__name__)


def _safe_json(response) -> dict:
    """Best-effort JSON decode used only to classify a response for logging.

    A provider 5xx or an HTML error page from an intermediary is not JSON, and
    a logging branch must never be the thing that raises.
    """
    try:
        data = response.json()
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


# Two shapes that a credential embedded in provider prose can take.
#
# _JWT: the provider's participant token is a JWT, so it always begins with
# the base64url of `{"` -- `eyJ` -- followed by two more dot-separated
# base64url segments. Anchoring on `eyJ` is what keeps this from eating
# ordinary dotted text such as a hostname or a version number.
#
# _OPAQUE_RUN: a long separator-free run, for a non-JWT secret. Deliberately
# EXCLUDES `-` so a UUID (longest dash-free run: 12 hex chars) survives
# intact -- meeting ids are the most useful thing in these log lines.
_JWT = re.compile(r'eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*')
_OPAQUE_RUN = re.compile(r'[A-Za-z0-9_]{24,}')


def _numeric(value) -> str:
    """Render an allowlisted provider error *code*, strictly as a number."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return "?"
    return str(value)


#Bounds on the exact-match scan. A hostile or broken provider body must not
#be able to turn a log line into unbounded work on a gunicorn worker: the
#message is truncated BEFORE any substitution runs, and only this many
#distinct strings are ever scanned for.
_MESSAGE_LIMIT = 200
_MAX_SECRETS = 200
_MAX_DEPTH = 8

#Sentinel meaning "the body was too big/deep to vet exhaustively".
_TRUNCATED = object()


def _secrets_in(node, out=None, depth: int = 0):
    """Every string this response body actually carries, at any depth.

    The credential that matters is not hypothetical: it is in the response we
    are holding. Collecting its strings lets the log redact them by EXACT
    MATCH, which is complete for the real threat (a provider that reports a
    partial failure and puts the token it just minted into the message) and
    does not depend on guessing a token's shape.

    Traversal is depth- and count-bounded. A blown bound is not a silent
    hole: the caller falls back to dropping the message entirely rather than
    logging prose it could not fully vet.
    """
    if out is None:
        out = set()
    if depth > _MAX_DEPTH or len(out) > _MAX_SECRETS:
        out.add(_TRUNCATED)
        return out
    if isinstance(node, dict):
        for v in node.values():
            _secrets_in(v, out, depth + 1)
    elif isinstance(node, list):
        for v in node:
            _secrets_in(v, out, depth + 1)
    elif isinstance(node, str) and len(node) >= 8:
        out.add(node)
    return out


def _strip_message(body: dict) -> dict:
    """``body`` with only ``error.message`` removed.

    Removing just that one leaf -- rather than the whole ``error`` subtree --
    means a token repeated at ``error.details.token`` is still discovered,
    while the message is not redacted against its own words. And because the
    message itself is gone from the set, a message that IS the credential
    verbatim still matches some other copy and is redacted whole.
    """
    err = body.get('error')
    if not isinstance(err, dict) or 'message' not in err:
        return body
    return {
        **body,
        'error': {k: v for k, v in err.items() if k != 'message'},
    }


def _redacted(value, body=None) -> str:
    """Render an allowlisted provider error *message* for a log line.

    Guards, because a "never log credentials" invariant must not rest on the
    provider's goodwill (codex adversarial review):

    - never a container: a nested object could be an arbitrary payload, and
      the point of the allowlist is that only known-scalar fields get out;
    - truncated FIRST, so redaction work is bounded by _MESSAGE_LIMIT no
      matter how large the provider's string is;
    - every string carried elsewhere in THIS response is redacted by exact
      match, so a diagnostic that embeds the token the call just minted
      cannot leak it whatever shape that token has -- including when the
      message is nothing but the token;
    - token-shaped runs are redacted too, as a backstop for a credential
      that arrives only inside the message;
    - if the body could not be vetted exhaustively, the message is dropped
      rather than logged.

    The message is kept (rather than dropped) in the normal case because
    ``DyteMeeting.post`` retries on the provider's ``error`` and an operator
    needs to know which error it was.
    """
    if value is None or isinstance(value, (dict, list)):
        return "?"
    # Truncate before substituting: this is the bound on all work below.
    text = str(value)[:_MESSAGE_LIMIT]
    if isinstance(body, dict):
        secrets = _secrets_in(_strip_message(body))
        if _TRUNCATED in secrets:
            return "[unvetted]"
        # Longest first, so a substring cannot pre-empt its container.
        for secret in sorted(
            (s for s in secrets if isinstance(s, str)),
            key=len, reverse=True,
        ):
            text = text.replace(secret, '[redacted]')
    text = _JWT.sub('[redacted]', text)
    return _OPAQUE_RUN.sub('[redacted]', text)


def _timeout():
    """The (connect, read) tuple every outbound provider call must carry.

    Read from settings at CALL time, not import time, so an operator can
    change it with an env var + restart and so `override_settings` works in
    tests. `requests` has no default timeout at all: without this a provider
    that accepts the TCP connection and then never answers pins the calling
    thread for the life of the process -- a gunicorn worker on the join
    path, and the whole catch-all `default` procrastinate lane on the
    sweep path.
    """
    return (
        settings.DYTE_CONNECT_TIMEOUT_SECONDS,
        settings.DYTE_READ_TIMEOUT_SECONDS,
    )


class DyteClient(object):

    def __init__(self, org):
        self.org = org

    # def get_participants_count(self, meeting_id) -> int:
    #     url = f"https://api.dyte.io/v2/meetings/{meeting_id}/participants"
    #     auth = HTTPBasicAuth(self.org, settings.DYTE_KEY)
    #     headers = {
    #         "Content-Type": "application/json",
    #     }
    #     response = requests.get(url, headers=headers, auth=auth)
    #     logger.info(f"get_participants_count response = {response.json()}")
    #     return response.json().get('paging', {}).get('total_count', 0)

    def get_participants_count(self, meeting_id) -> int:
        """
        Live participant count for a meeting, or 0 when nobody is in it.

        Returning 0 always means "confirmed empty", never "the probe
        failed" — dyte.sweep_live_meetings relies on that distinction to
        only clear live_now on a confirmed zero, so anything we cannot
        interpret raises instead.

        A 404 from /active-session is NOT an error: it is how Cloudflare
        RealtimeKit (ex-Dyte) reports "this meeting has no session running
        right now". Verified against the live API with prod credentials:

            GET /v2/meetings/<id>                 -> 200 (meeting exists)
            GET /v2/meetings/<id>/active-session  -> 404
                {"success": false, "error": {"code": 404,
                 "message": "No active session found for meeting id: <id>"}}
            GET /v2/sessions?associated_id=<id>   -> 200 {"sessions": []}
            ...with bad credentials                -> 401 "Invalid access token"

        So 404 is the single most common, fully expected response (every
        idle room returns it), auth failures are 401, and a blanket
        raise_for_status() here turned the normal case into an exception.
        """
        url = f"{settings.RTK_API_BASE_URL}/v2/meetings/{meeting_id}/active-session"
        auth = HTTPBasicAuth(self.org, settings.DYTE_KEY)
        headers = {
            "Content-Type": "application/json",
        }
        response = requests.get(
            url, headers=headers, auth=auth, timeout=_timeout()
        )
        if response.status_code == 404:
            # Definitive information: no session is running -> zero live
            # participants. Callers may act on this (clear live_now).
            logger.debug(
                "get_participants_count: no active session for %s", meeting_id)
            return 0
        # Any other non-2xx (401/403 auth, 5xx provider,...) is a genuine
        # failure and must not be mistaken for an empty room.
        response.raise_for_status()
        logger.debug(f"get_participants_count response = {response.json()}")
        return response.json().get('data', {}).get('live_participants', 0)

    # Dyte carnage on backwards compatibility
    # Actually a regression
    # https://discord.com/channels/872824138048352277/1253228307227349004
    # def get_participants_count(self, meeting_id) -> requests.Response:
    #     """
    #     from dj.apps.dyte.client import DyteClient
    #     dc = DyteClient("7dba0970-3d0b-45e4-97dc-17029162fcc5")
    #     r = dc.get_participants_count("bbb25584-2790-48bb-8955-112eb565b7d1")
    #     """
    #     # url = f'https://api.cluster.dyte.in/v2/meetings/{meeting_id}/participants?status=active'
    #     # url = f'https://api.dyte.io/v2/meetings/{meeting_id}/participants/active'
    #     # url = f'https://api.cluster.dyte.in/v2/meetings/{meeting_id}'
    #     url = f'https://api.dyte.io/v2/meetings/{meeting_id}/active-session'

    #     auth = HTTPBasicAuth(self.org, settings.DYTE_KEY)
    #     headers = {
    #         "Content-Type": "application/json",
    #     }
    #     response = requests.get(url, headers=headers, auth=auth)
    #     data = response.json()
    #     # count = data.get('paging', {}).get('total_count', 0)
    #     # return count
    #     return response
    #     # import IPython; IPython.embed()

    #     # # Check if the request was successful
    #     # if response.status_code == 200:
    #     #     data = response.json()
    #     #     # Access the participants' information
    #     #     participants = data.get('data', {}).get('participants', {})
    #     #     # Count the total number of participants
    #     #     total_participants = len(participants.get('joined', []))
    #     #     print(f'Total participants: {total_participants}')
    #     # else:
    #     #     print(f'Failed to fetch meeting details: {response.status_code}, {response.text}')

    def create_meeting(self, title) -> requests.Response:
        """
        import requests

        url = "https://api.dyte.io/v2/meetings"

        payload = {
            "title": "string",
            "preferred_region": "ap-south-1",
            "record_on_start": False,
            "live_stream_on_start": False,
            "recording_config": {
                "max_seconds": 60,
                "file_name_prefix": "string",
                "video_config": {
                    "codec": "H264",
                    "width": 1280,
                    "height": 720,
                    "watermark": {
                        "url": "http://example.com",
                        "size": {
                            "width": 1,
                            "height": 1
                        },
                        "position": "left top"
                    }
                },
                "audio_config": {
                    "codec": "AAC",
                    "channel": "stereo"
                },
                "storage_config": {
                    "type": "aws",
                    "access_key": "string",
                    "secret": "string",
                    "bucket": "string",
                    "region": "us-east-1",
                    "path": "string",
                    "auth_method": "KEY",
                    "username": "string",
                    "password": "string",
                    "host": "string",
                    "port": 0,
                    "private_key": "string"
                },
                "dyte_bucket_config": {"enabled": True},
                "live_streaming_config": {"rtmp_url": "rtmp://a.rtmp.youtube.com/live2"}
            }
        }
        headers = {
            "Content-Type": "application/json",
            "Authorization": "Basic undefined"
        }

        response = requests.request("POST", url, json=payload, headers=headers)

        """
        # url = /v2/meetings
        # https://docs.realtime.cloudflare.com/guides/rest-apis/quickstart
        url = f"{settings.RTK_API_BASE_URL}/v2/meetings"
        payload = {
            "title": title,
        }
        headers = {
            "Content-Type": "application/json",
        }
        auth = HTTPBasicAuth(self.org, settings.DYTE_KEY)
        response = requests.post(
            url, json=payload, headers=headers, auth=auth, timeout=_timeout()
        )
        #.data.id
        return response

    def kick_participants(self, meeting_id: str, participant_ids) -> bool:
        """Remove participants from the meeting's active session.

        Used when the broadcaster seat moves to another tab: the previous host
        is disconnected at the provider, not just told to leave by our API.
        Best effort by design -- the caller has already moved the seat and
        must not fail a take-over because the provider hiccuped. A 404 means
        no session is running, which is the outcome we wanted anyway.
        Returns whether the provider confirmed (or no session existed).
        """
        ids = [str(pid) for pid in participant_ids if pid]
        if not ids:
            return True
        url = (
            f"{settings.RTK_API_BASE_URL}/v2/meetings/{meeting_id}"
            "/active-session/kick"
        )
        auth = HTTPBasicAuth(self.org, settings.DYTE_KEY)
        try:
            response = requests.post(
                url, json={"participant_ids": ids},
                headers={"Content-Type": "application/json"},
                auth=auth, timeout=_timeout(),
            )
        except requests.RequestException as exc:
            logger.warning(
                "kick_participants: request failed meeting=%s: %s",
                meeting_id, type(exc).__name__)
            return False
        if response.status_code == 404 or response.status_code < 300:
            return True
        logger.warning(
            "kick_participants: provider status=%s meeting=%s",
            response.status_code, meeting_id)
        return False

    def retire_participant(self, meeting_id: str, participant_id: str) -> bool:
        """Take a previous host off the air for good.

        Kick FIRST, then delete -- the order Cloudflare documents: kicking
        disconnects a peer that is connected right now, deleting the
        participant revokes its token so it cannot (re)join. Deleting first
        could leave the kick resolving nothing (404) while a live connection
        survives. True only when both are confirmed (404 = already gone).
        """
        kicked = self.kick_participants(meeting_id, [participant_id])
        url = (
            f"{settings.RTK_API_BASE_URL}/v2/meetings/{meeting_id}"
            f"/participants/{participant_id}"
        )
        auth = HTTPBasicAuth(self.org, settings.DYTE_KEY)
        try:
            response = requests.delete(
                url, headers={"Content-Type": "application/json"},
                auth=auth, timeout=_timeout(),
            )
        except requests.RequestException as exc:
            logger.warning(
                "retire_participant: delete failed meeting=%s: %s",
                meeting_id, type(exc).__name__)
            return False
        deleted = response.status_code < 300 or response.status_code == 404
        if not deleted:
            logger.warning(
                "retire_participant: delete status=%s meeting=%s",
                response.status_code, meeting_id)
        return kicked and deleted

    def add_participant(
        self, creator: Creator, meeting_id: str, *, role: str = None, custom_participant_id: str = None,
    ) -> requests.Response:
        """
        import requests

        url = "https://api.dyte.io/v2/meetings/meeting_id/participants"

        payload = {
            "name": "Mary Sue",
            "picture": "https://i.imgur.com/test.jpg",
            "preset_name": "string",
            "custom_participant_id": "string"
        }
        headers = {
            "Content-Type": "application/json",
            "Authorization": "Basic undefined"
        }

        response = requests.request("POST", url, json=payload, headers=headers)
        """
        # url = /v2/meetings/{meetingId}/participants
        url = f"{settings.RTK_API_BASE_URL}/v2/meetings/{meeting_id}/participants"
        cm = CreatorMeeting.objects.get(meeting_id=meeting_id)

        logger.info(f"meeting owner = {cm.creator.username}, participant = {creator.username}")

        # RealtimeKit fetches participant pictures in the browser. Legacy
        # free2z.com URLs redirect across origins and fail CSP/CORS on the
        # canonical site. Use this deployment's origin and existing paths.
        picture_path = default_logo_url()
        if not creator.is_authenticated:
            username = f"Guest {uuid.uuid4()}"
        else:
            username = creator.username
            if creator.avatar_image:
                picture_path = creator.avatar_image.get_thumbnail() or picture_path
        picture_url = f"{settings.CANONICAL_ORIGIN.rstrip('/')}{picture_path}"

        # The caller knows whether this is a host start or a viewer join, and
        # that is authoritative: the creator opening their own public stream
        # page must get the participant preset, never the host one, or it
        # publishes into its own live broadcast. The username
        # inference survives only for callers that do not say.
        if role is None:
            role = 'host' if cm.creator.username == creator.username else 'viewer'
        if role not in ('host', 'viewer'):
            raise ValueError('role must be host or viewer')

        if role == 'host':
            logger.info("creator is joining their own meeting")
            preset = "webinar1"
        else:
            logger.info("participant is joining someone else's meeting")
            preset = "webinar-participant"

        if custom_participant_id is None and cm.meeting_type=='ppv' and creator.is_authenticated and creator.pk==cm.creator_id:
            from dj.apps.economy.models import EconomicPolicy
            if EconomicPolicy.objects.filter(pk=True,version=1).exists():
                # Usernames cannot impersonate a compensated admission. Both
                # host starts and the host's own viewer seat use this identity.
                custom_participant_id=f'ph_{creator.public_id.hex}'

        payload = {
            "name": username,
            "picture": picture_url,
            "preset_name": preset,
            "custom_participant_id": custom_participant_id or username,
        }
        headers = {
            "Content-Type": "application/json",
        }
        auth = HTTPBasicAuth(self.org, settings.DYTE_KEY)
        response = requests.post(
            url, json=payload, headers=headers, auth=auth, timeout=_timeout()
        )
        # NEVER log the response body, on ANY path. On success it contains
        # data.token, a bearer credential that lets whoever holds it join
        # this meeting as this participant. Root logging is INFO in prod
        # (free2z/settings.py LOGGING), so an f-string of response.json()
        # wrote a live, joinable token into Cloud Logging on every host and
        # every viewer join.
        #
        # The failure path logs an ALLOWLIST of two scalar fields, not the
        # raw text: nothing documents that an error envelope cannot also
        # carry `data.token` (the provider can create the participant and
        # still report a partial failure), and an intermediary's diagnostic
        # page is not a schema we control. Allowlisting is the only form
        # that stays safe when the body's shape changes underneath us.
        body = _safe_json(response)
        data = body.get('data')
        # "ok" must mean the ONE thing the callers need: a usable token came
        # back. A malformed 2xx -- HTML from a proxy, a bare list, `{}`,
        # `{"success": false}` with no `error` key -- used to log "ok" and
        # then 500 the caller one line later on `resp.json()['data']['token']`.
        # During a provider incident that made every join fail while the
        # diagnostic said success.
        ok = (
            response.status_code < 400
            and 'error' not in body
            and isinstance(data, dict)
            and isinstance(data.get('token'), str)
        )
        if not ok:
            err = body.get('error')
            err = err if isinstance(err, dict) else {}
            logger.warning(
                "add_participant failed: status=%s participant=%s "
                "provider_code=%s provider_message=%s",
                response.status_code, username,
                _numeric(err.get('code')),
                # The whole body is the exact-match redaction set (minus the
                # message itself), so `data.token` -- or a copy of it under
                # any other key, at any depth -- cannot ride out inside the
                # provider's prose.
                _redacted(err.get('message'), body=body),
            )
        else:
            logger.info(
                "add_participant ok: status=%s participant=%s",
                response.status_code, username,
            )
        return response
