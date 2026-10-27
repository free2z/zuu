"""Owner recording controls backed by provider state, independent of SDK events."""

import uuid

import requests
from django.conf import settings
from django.core.cache import cache
from django.db import transaction
from django.utils import timezone
from drf_spectacular.utils import extend_schema
from requests.auth import HTTPBasicAuth
from rest_framework import serializers
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from dj.free2z.throttling import POLLING_THROTTLES
from .models import CreatorMeeting, PUBLIC_MEETING_TYPES, PRIVATE

ACTIVE = {"INVOKED", "RECORDING", "PAUSED"}
STATES = ACTIVE | {"STOPPING", "UPLOADING", "UPLOADED", "FAILED", "ERRORED"}
# Provider requests that time out can still have started a recording. Keep an
# admission marker through the maximum capture duration; never blindly retry.
MAX_SECONDS = 4 * 60 * 60
PROVIDER_TIMEOUT = (2, 3)
PROVIDER_CIRCUIT = "rtk-recording-provider-unavailable"


class RecordingRequestSerializer(serializers.Serializer):
    host_session = serializers.UUIDField()


class RecordingStatusSerializer(serializers.Serializer):
    recording_state = serializers.ChoiceField(choices=["IDLE", *sorted(STATES)])


class ProviderUnavailable(Exception):
    pass


class ProviderRejected(ProviderUnavailable):
    pass


def provider(method, path, *, payload=None, allow_empty=False):
    if cache.get(PROVIDER_CIRCUIT):
        raise ProviderUnavailable()
    try:
        response = requests.request(
            method,
            f"{settings.RTK_API_BASE_URL}/v2/{path}",
            auth=HTTPBasicAuth(settings.DYTE_ORG, settings.DYTE_KEY),
            json=payload,
            timeout=PROVIDER_TIMEOUT,
        )
    except requests.RequestException:
        cache.set(PROVIDER_CIRCUIT, True, 10)
        raise
    if response.status_code >= 500:
        cache.set(PROVIDER_CIRCUIT, True, 10)
    try:
        body = response.json()
    except ValueError as exc:
        raise ProviderUnavailable() from exc
    if allow_empty and response.status_code == 404:
        error = body.get("error", {}) if isinstance(body, dict) else {}
        if (
            isinstance(error, dict)
            and error.get("code") == 404
            and str(error.get("message", "")).startswith(
                "No active recording for meeting "
            )
        ):
            return None
    if (
        response.status_code in {400, 401, 403, 404, 422}
        and isinstance(body, dict)
        and body.get("success") is False
    ):
        raise ProviderRejected()
    if not response.ok or not isinstance(body, dict) or body.get("success") is not True:
        raise ProviderUnavailable()
    return body.get("data")


def checked_recording(data, meeting_id):
    if (
        not isinstance(data, dict)
        or data.get("meeting_id") != meeting_id
        or data.get("status") not in STATES
    ):
        raise ProviderUnavailable()
    try:
        uuid.UUID(data["id"])
    except (KeyError, ValueError, TypeError, AttributeError) as exc:
        raise ProviderUnavailable() from exc
    return data


def recording_status(cm):
    key = f"rtk-recording:{cm.meeting_id}"
    active = provider(
        "GET", f"recordings/active-recording/{cm.meeting_id}", allow_empty=True
    )
    if active is not None:
        active = checked_recording(active, cm.meeting_id)
        return active
    if cache.get(f"{key}:pending"):
        raise ProviderUnavailable()
    previous = cache.get(key)
    if previous:
        result = checked_recording(
            provider("GET", f"recordings/{previous}"), cm.meeting_id
        )
        return result
    return None


def reconcile_recording(cm):
    """Mutation-only reconciliation; caller holds the host-seat row lock."""
    current = recording_status(cm)
    if current and current["status"] in ACTIVE:
        key = f"rtk-recording:{cm.meeting_id}"
        cache.set(key, current["id"], MAX_SECONDS + 3600)
        cache.delete(f"{key}:pending")
    return current


def can_record():
    # Hosts are issued the webinar1 preset in DyteClient.add_participant.
    # Read its permission rather than treating organization API credentials as
    # permission to override a disabled recording preset.
    data = provider("GET", "presets")
    presets = data
    if not isinstance(presets, list) or any(not isinstance(p, dict) for p in presets):
        raise ProviderUnavailable()
    matches = [p for p in presets if p.get("name") == "webinar1"]
    if len(matches) != 1:
        raise ProviderUnavailable()
    preset_id = str(uuid.UUID(str(matches[0]["id"])))
    preset = provider("GET", f"presets/{preset_id}")
    if not isinstance(preset, dict):
        raise ProviderUnavailable()
    permissions = preset.get("permissions")
    if not isinstance(permissions, dict):
        raise ProviderUnavailable()
    return permissions.get("can_record") is True


def recorder_ready():
    response = requests.get(
        f"{settings.CANONICAL_ORIGIN.rstrip('/')}/tools/recording/index.html",
        headers={"Cache-Control": "no-cache"},
        allow_redirects=False,
        timeout=PROVIDER_TIMEOUT,
    )
    return (
        response.status_code == 200
        and response.headers.get("X-Free2Z-Recorder-Ready") == "1"
    )


class RecordingControl(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = POLLING_THROTTLES

    def _meeting(self, request, data, *, lock=False):
        from .views import _seat_is_fresh

        serializer = RecordingRequestSerializer(data={"host_session": data.get("host_session")})
        serializer.is_valid(raise_exception=True)
        meetings = CreatorMeeting.objects.select_for_update(of=("self",)) if lock else CreatorMeeting.objects
        cm = meetings.filter(
            creator=request.user,
            host_session_id=serializer.validated_data["host_session"],
            meeting_type__in=PUBLIC_MEETING_TYPES,
            is_public=True,
        ).first()
        return cm if cm is not None and _seat_is_fresh(cm, timezone.now()) else None

    def _mutate(self, request, username, *, action):
        from .views import is_path_owner

        if not is_path_owner(request, {"username": username}) or (
            action == "start" and not request.user.can_stream
        ):
            return Response(
                {"error": "Only the stream owner can manage recordings."}, status=403
            )
        cm = None
        try:
            with transaction.atomic():
                cm = self._meeting(request, request.data, lock=True)
                if cm is None:
                    return Response(
                        {"error": "This tab no longer holds the live host session."},
                        status=409,
                    )
                current = reconcile_recording(cm)
                if action == "start":
                    if current and current["status"] in ACTIVE | {
                        "STOPPING",
                        "UPLOADING",
                    }:
                        return Response({"recording_state": current["status"]})
                    if not can_record():
                        return Response(
                            {"error": "Recording is not permitted for this host."},
                            status=403,
                        )
                    if not recorder_ready():
                        raise ProviderUnavailable()
                    key = f"rtk-recording:{cm.meeting_id}"
                    if not cache.add(
                        f"{key}:pending", str(uuid.uuid4()), MAX_SECONDS + 300
                    ):
                        raise ProviderUnavailable()
                    # No client-supplied URL, meeting ID or recording ID reaches
                    # the provider. The recording route is deployed by us.
                    try:
                        current = checked_recording(
                            provider(
                                "POST",
                                "recordings",
                                payload={
                                    "meeting_id": cm.meeting_id,
                                    "url": f"{settings.CANONICAL_ORIGIN.rstrip('/')}/tools/recording/index.html",
                                    "max_seconds": MAX_SECONDS,
                                },
                            ),
                            cm.meeting_id,
                        )
                    except ProviderRejected:
                        cache.delete(f"{key}:pending")
                        raise
                    cache.set(key, current["id"], MAX_SECONDS + 3600)
                    cache.delete(f"{key}:pending")
                elif action == "stop" and current and current["status"] in ACTIVE:
                    stopped = provider(
                        "PUT", f"recordings/{current['id']}", payload={"action": "stop"}
                    )
                    # The stop response is an acknowledgement; authoritative
                    # state comes from subsequent GETs, not a fabricated event.
                    if stopped is None:
                        raise ProviderUnavailable()
                    return Response({"recording_state": "STOPPING"})
                return Response(
                    {"recording_state": current["status"] if current else "IDLE"}
                )
        except (
            ProviderUnavailable,
            requests.RequestException,
            ValueError,
            TypeError,
            KeyError,
        ):
            return Response(
                {
                    "error": "Recording status could not be confirmed. Check again before starting another recording."
                },
                status=503,
            )
        finally:
            if cm is not None:
                cache.delete(f"rtk-recording-status:{cm.meeting_id}")

    @extend_schema(
        parameters=[RecordingRequestSerializer],
        responses={200: RecordingStatusSerializer},
    )
    def get(self, request, username, **kwargs):
        # Keep the GET call graph structurally observational. It shares neither
        # mutation reconciliation nor admission cleanup with POST/DELETE.
        from .views import is_path_owner

        if not is_path_owner(request, {"username": username}):
            return Response(
                {"error": "Only the stream owner can manage recordings."}, status=403
            )
        cm = self._meeting(request, request.query_params)
        if cm is None:
            return Response(
                {"error": "This tab no longer holds the live host session."}, status=409
            )
        try:
            status_key = f"rtk-recording-status:{cm.meeting_id}"
            cached = cache.get(status_key)
            current = (
                cached["recording"] if cached is not None else recording_status(cm)
            )
            if cached is None:
                cache.set(status_key, {"recording": current}, 5)
            return Response(
                {"recording_state": current["status"] if current else "IDLE"}
            )
        except (
            ProviderUnavailable,
            requests.RequestException,
            ValueError,
            TypeError,
            KeyError,
        ):
            return Response(
                {
                    "error": "Recording status could not be confirmed. Check again before starting another recording."
                },
                status=503,
            )

    @extend_schema(
        request=RecordingRequestSerializer, responses={200: RecordingStatusSerializer}
    )
    def post(self, request, username, **kwargs):
        return self._mutate(request, username, action="start")


class RecordingStopControl(RecordingControl):
    http_method_names = ["post", "options"]

    @extend_schema(
        request=RecordingRequestSerializer, responses={200: RecordingStatusSerializer}
    )
    def post(self, request, username, **kwargs):
        return self._mutate(request, username, action="stop")


class PrivateRecordingControl(RecordingControl):
    """Manage only the owner's existing secret-scoped private room.

    Unlike public broadcasts, private calls have no public host-seat lease.
    The authenticated owner AND the current invitation secret identify the
    room; a participant's invitation never confers recording authority.
    """

    def _meeting(self, request, data, *, lock=False):
        meetings = CreatorMeeting.objects.select_for_update(of=("self",)) if lock else CreatorMeeting.objects
        cm = meetings.filter(
            creator=request.user, creator__is_active=True,
            meeting_type=PRIVATE, is_public=False, secret=self.kwargs["secret"],
        ).first()
        if cm is None or not cm.meeting_id:
            raise NotFound()
        if cm.e2ee:
            raise PermissionDenied("End-to-end encrypted calls cannot be recorded.")
        return cm

    @extend_schema(parameters=[], responses={200: RecordingStatusSerializer})
    def get(self, request, username, **kwargs):
        return super().get(request, username, **kwargs)

    @extend_schema(request=None, responses={200: RecordingStatusSerializer})
    def post(self, request, username, **kwargs):
        return self._mutate(request, username, action="start")


class PrivateRecordingStopControl(PrivateRecordingControl):
    http_method_names = ["post", "options"]

    @extend_schema(request=None, responses={200: RecordingStatusSerializer})
    def post(self, request, username, **kwargs):
        return self._mutate(request, username, action="stop")
