"""Owner recording controls backed by provider state, independent of SDK events."""

import uuid

import requests
from django.conf import settings
from django.core.cache import cache
from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.utils import extend_schema
from rest_framework import serializers
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from dj.free2z.throttling import POLLING_THROTTLES
from .client import (
    DyteClient, ProviderAuthError, ProviderError, ProviderNotFoundError,
    ProviderRejectedError, ProviderUnavailableError,
)
from .models import CreatorMeeting, PUBLIC_MEETING_TYPES, PRIVATE

ACTIVE = {"INVOKED", "RECORDING", "PAUSED"}
PUBLIC_RECORDING_TTL = 120


def publish_public_recording(meeting_id, status):
    """Remember whether a room is being recorded, for people who cannot poll it.

    The browser SDK only learns about a server-started recording if it receives
    a room event. Someone already on stage often does not. Viewers read this
    flag from live status instead of the owner recording API.
    """
    cache.set(
        f"rtk-recording-public:{meeting_id}",
        status in ACTIVE,
        PUBLIC_RECORDING_TTL,
    )


def public_recording(meeting_id):
    return cache.get(f"rtk-recording-public:{meeting_id}") is True
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
    client = DyteClient()
    try:
        response = client.request(method, path, payload=payload, timeout=PROVIDER_TIMEOUT, allow_ack=method == 'PUT')
        return response.json()['data']
    except ProviderNotFoundError:
        if allow_empty and path.startswith('recordings/active-recording/'):
            # An idle 404 counts as "no recording" only once the meeting is
            # confirmed to exist -- under the same short deadline and the
            # same circuit breaker as every other recording-control call.
            try:
                client._meeting(client.request(
                    'GET', f"meetings/{path.rsplit('/', 1)[-1]}",
                    timeout=PROVIDER_TIMEOUT))
            except ProviderError as exc:
                if isinstance(exc, ProviderUnavailableError):
                    cache.set(PROVIDER_CIRCUIT, True, 10)
                raise ProviderUnavailable() from None
            return None
        raise ProviderRejected() from None
    except (ProviderRejectedError, ProviderAuthError):
        # A definitive refusal (4xx, including 401/403 credentials): nothing
        # started, so callers must release their pending marker rather than
        # hold it for a recording that does not exist.
        raise ProviderRejected() from None
    except ProviderError as exc:
        if isinstance(exc, ProviderUnavailableError):
            cache.set(PROVIDER_CIRCUIT, True, 10)
        raise ProviderUnavailable() from None


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
        announced = None
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
                        announced = current["status"]
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
                    announced = current["status"]
                elif action == "stop" and current and current["status"] in ACTIVE:
                    stopped = provider(
                        "PUT", f"recordings/{current['id']}", payload={"action": "stop"}
                    )
                    # The stop response is an acknowledgement; authoritative
                    # state comes from subsequent GETs, not a fabricated event.
                    if stopped is None:
                        raise ProviderUnavailable()
                    announced = "STOPPING"
                    return Response({"recording_state": "STOPPING"})
                announced = current["status"] if current else "IDLE"
                return Response(
                    {"recording_state": announced}
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
                if announced is not None:
                    publish_public_recording(cm.meeting_id, announced)

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
            state = current["status"] if current else "IDLE"
            publish_public_recording(cm.meeting_id, state)
            return Response(
                {"recording_state": state}
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


class PrivateRecordingVisibility(APIView):
    """Whether a private room is being recorded, for anyone holding its secret.

    The owner recording API stays owner-only. Invitees on stage need the same
    yes-or-no the public live status gives broadcast, subscribers-only, and
    pay-per-view viewers.
    """

    permission_classes = [IsAuthenticated]
    throttle_classes = POLLING_THROTTLES

    @extend_schema(responses={200: serializers.Serializer})
    def get(self, request, username, secret, **kwargs):
        cm = get_object_or_404(
            CreatorMeeting,
            creator__username__iexact=username,
            creator__is_active=True,
            meeting_type=PRIVATE,
            is_public=False,
            secret=secret,
        )
        return Response({
            "recording": public_recording(cm.meeting_id) if cm.meeting_id else False,
        })


class PrivateRecordingStopControl(PrivateRecordingControl):
    http_method_names = ["post", "options"]

    @extend_schema(request=None, responses={200: RecordingStatusSerializer})
    def post(self, request, username, **kwargs):
        return self._mutate(request, username, action="stop")
