"""Producer adapter for the documented Cloudflare API (never renderer truth).

See docs/free2z/live/producer.md for API sources and deployment acceptance.
No automatic retries of non-idempotent provider POSTs.
"""

import re
import uuid

import requests
from django.conf import settings
from django.utils.dateparse import parse_datetime


class ProviderUnavailable(Exception):
    pass


def configured():
    return bool(
        re.fullmatch(r"[a-fA-F0-9]{32}", settings.RTK_PRODUCER_ACCOUNT_ID)
        and settings.RTK_PRODUCER_APP_ID
        and settings.RTK_PRODUCER_API_TOKEN
        and settings.RTK_PRODUCER_HOST_PRESET
        # Viewer joins still use the compatibility API for this same app.
        and settings.DYTE_ORG == settings.RTK_PRODUCER_APP_ID
        and settings.DYTE_KEY
    )


class ProducerProvider:
    def __init__(self):
        if not configured():
            raise ProviderUnavailable()
        self.base = (
            "https://api.cloudflare.com/client/v4/accounts/"
            f"{settings.RTK_PRODUCER_ACCOUNT_ID}/realtime/kit/"
            f"{settings.RTK_PRODUCER_APP_ID}"
        )

    def request(self, method, path, *, absent_ok=False, **kwargs):
        try:
            response = requests.request(
                method,
                self.base + path,
                headers={"Authorization": f"Bearer {settings.RTK_PRODUCER_API_TOKEN}"},
                timeout=(
                    settings.DYTE_CONNECT_TIMEOUT_SECONDS,
                    settings.DYTE_READ_TIMEOUT_SECONDS,
                ),
                **kwargs,
            )
            if absent_ok and response.status_code == 404:
                return {}
            body = response.json()
            if response.status_code >= 300 or body.get("success") is not True:
                raise ProviderUnavailable()
            return body["data"]
        except (
            requests.RequestException,
            ValueError,
            KeyError,
            TypeError,
            AttributeError,
        ):
            # Never return/log response prose, credentials, or private URLs.
            raise ProviderUnavailable() from None

    def check(self):
        return isinstance(
            self.request("GET", "/meetings", params={"per_page": 1}), list
        )

    def create(self, title):
        data = self.request(
            "POST",
            "/meetings",
            json={
                "title": title,
                "record_on_start": False,
                "live_stream_on_start": False,
            },
        )
        if not isinstance(data, dict):
            raise ProviderUnavailable()
        return str(uuid.UUID(data["id"]))

    def find(self, title):
        # An empty list is a snapshot, never permission to re-create an
        # ambiguously accepted POST. Exact title includes our durable UUID.
        data = self.request(
            "GET", "/meetings", params={"search": title, "per_page": 100}
        )
        if (
            not isinstance(data, list)
            or len(data) >= 100
            or any(not isinstance(row, dict) for row in data)
        ):
            raise ProviderUnavailable()
        return [str(uuid.UUID(row["id"])) for row in data if row.get("title") == title]

    def token(self, room, custom_id, creator):
        data = self.request(
            "POST",
            f"/meetings/{room}/participants",
            json={
                "name": creator.username,
                "preset_name": settings.RTK_PRODUCER_HOST_PRESET,
                "custom_participant_id": custom_id,
            },
        )
        if not isinstance(data, dict):
            raise ProviderUnavailable()
        participant = str(uuid.UUID(data["id"]))
        token = data["token"]
        if not isinstance(token, str) or not token:
            raise ProviderUnavailable()
        return participant, token

    def retire(self, room, participant):
        # Kick BEFORE delete, matching the existing host-seat retirement path.
        self.request(
            "POST",
            f"/meetings/{room}/active-session/kick",
            json={"participant_ids": [participant]},
            absent_ok=True,
        )
        self.request(
            "DELETE", f"/meetings/{room}/participants/{participant}", absent_ok=True
        )

    def live(self, room, participant):
        data = self.request("GET", f"/meetings/{room}/active-session")
        if not isinstance(data, dict) or data.get("status") != "LIVE":
            raise ProviderUnavailable()
        count = data.get("live_participants")
        if type(count) is not int or count < 1:
            raise ProviderUnavailable()
        session = str(uuid.UUID(data["id"]))
        details = self.request("GET", f"/sessions/{session}/participants/{participant}")
        host = details.get("participant") if isinstance(details, dict) else None
        # A session with viewers alone is not a host broadcast. Missing or
        # contradictory participant identity/presence is unavailable truth.
        if (
            not isinstance(host, dict)
            or host.get("user_id") != participant
            or not isinstance(host.get("joined_at"), str)
            or parse_datetime(host["joined_at"]) is None
            or host.get("left_at")
        ):
            raise ProviderUnavailable()
        return session, count

    def disable(self, room):
        # Unlike kick-all, INACTIVE prevents token re-entry and removes peers.
        # This does NOT make a claim about invoices/settlement/recordings.
        data = self.request("PATCH", f"/meetings/{room}", json={"status": "INACTIVE"})
        if not isinstance(data, dict) or data.get("status") != "INACTIVE":
            raise ProviderUnavailable()
