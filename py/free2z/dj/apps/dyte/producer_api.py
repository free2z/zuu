"""Owner-only producer HTTP v1; no provider facts accepted from clients."""

from rest_framework import serializers
from rest_framework.parsers import JSONParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from drf_spectacular.utils import extend_schema
from drf_spectacular.extensions import OpenApiSerializerExtension
from . import producer
from .models import ProducerStream


class ProducerInstruction(serializers.Serializer):
    action = serializers.ChoiceField(
        choices=[
            "draft",
            "update",
            "provision",
            "refresh",
            "publish",
            "heartbeat",
            "interrupt",
            "takeover",
            "end",
        ]
    )
    idempotency_key = serializers.UUIDField()
    expected_actor_id = serializers.IntegerField(min_value=1)
    owner = serializers.UUIDField()
    version = serializers.IntegerField(min_value=1)
    title = serializers.CharField(max_length=120, trim_whitespace=False)
    description = serializers.CharField(
        max_length=2000, allow_blank=True, trim_whitespace=False
    )
    audience = serializers.ChoiceField(choices=["public", "private", "subscribers"])
    access = serializers.ChoiceField(choices=["free", "paid"])

    def to_internal_value(self, data):
        if not isinstance(data, dict) or set(data) - set(self.fields):
            raise serializers.ValidationError({"code": "unsupported_fields"})
        return super().to_internal_value(data)

    def validate_title(self, value):
        if not value.strip():
            raise serializers.ValidationError("A title is required.")
        return value


class ProducerInstructionSchema(OpenApiSerializerExtension):
    target_class = ProducerInstruction

    def map_serializer(self, auto_schema, direction):
        schema = auto_schema._map_serializer(
            self.target, direction, bypass_extensions=True
        )
        schema["additionalProperties"] = False
        return schema


class ProducerStatus(serializers.Serializer):
    id = serializers.UUIDField()
    state = serializers.ChoiceField(choices=list(producer.TRANSITIONS))
    version = serializers.IntegerField()
    title = serializers.CharField()
    description = serializers.CharField(allow_blank=True)
    audience = serializers.CharField()
    access = serializers.CharField()
    owner = serializers.UUIDField()
    room_id = serializers.UUIDField(allow_null=True)
    participants = serializers.IntegerField(allow_null=True)
    error_code = serializers.CharField(allow_blank=True)
    ended_at = serializers.DateTimeField(allow_null=True)
    heartbeat_seconds = serializers.IntegerField()
    grace_seconds = serializers.IntegerField()


class ProducerResult(serializers.Serializer):
    stream = ProducerStatus()
    operation = serializers.DictField()
    auth_token = serializers.CharField(allow_null=True)


class ProducerError(serializers.Serializer):
    code = serializers.CharField()
    stream = ProducerStatus(required=False)
    operation = serializers.DictField(required=False)
    auth_token = serializers.CharField(allow_null=True, required=False)


class ProducerReadiness(serializers.Serializer):
    eligible = serializers.BooleanField()
    ready = serializers.BooleanField()
    provider_configured = serializers.BooleanField()
    provider_reachable = serializers.BooleanField()
    supported_audiences = serializers.ListField(child=serializers.CharField())
    supported_access = serializers.ListField(child=serializers.CharField())
    contract_version = serializers.IntegerField()


ERRORS = {
    400: ProducerError,
    401: ProducerError,
    403: ProducerError,
    404: ProducerError,
    409: ProducerError,
    415: ProducerError,
    422: ProducerError,
    429: ProducerError,
    503: ProducerError,
}


class ProducerView(APIView):
    # Marker/claim transactions must commit before provider I/O, not at the
    # response boundary imposed by AtomicMiddleware.
    non_atomic_methods = frozenset({"POST"})
    permission_classes = [IsAuthenticated]
    parser_classes = [JSONParser]

    def handle_exception(self, exc):
        if isinstance(exc, producer.Refusal):
            return Response({"code": exc.code}, status=exc.status)
        result = super().handle_exception(exc)
        codes = {
            400: "invalid_instruction",
            401: "authentication_required",
            403: "permission_denied",
            415: "json_required",
            429: "rate_limited",
        }
        if result.status_code in codes:
            result.data = {"code": codes[result.status_code]}
        return result

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "no-store"
        return response

    @extend_schema(
        operation_id="dyte_producer_v1_readiness",
        responses={200: ProducerReadiness, **ERRORS},
    )
    def get(self, request):
        actor = producer.authenticate(request.user, request.user.pk)
        return Response(producer.readiness(actor))

    @extend_schema(
        operation_id="dyte_producer_v1_draft",
        request=ProducerInstruction,
        responses={200: ProducerResult, 202: ProducerResult, **ERRORS},
    )
    def post(self, request):
        return self.execute(request, None)

    def execute(self, request, stream_id):
        body = ProducerInstruction(data=request.data)
        if not body.is_valid():
            return Response({"code": "invalid_instruction"}, status=400)
        try:
            result, status = producer.execute(
                request.user, stream_id, body.validated_data
            )
            return Response(result, status=status)
        except producer.Refusal as exc:
            return Response({"code": exc.code}, status=exc.status)


class ProducerDetail(ProducerView):
    @extend_schema(
        operation_id="dyte_producer_v1_status",
        responses={200: ProducerStatus, **ERRORS},
    )
    def get(self, request, stream_id):
        producer.authenticate(request.user, request.user.pk)
        stream = ProducerStream.objects.filter(
            creator=request.user, pk=stream_id
        ).first()
        if stream is None:
            return Response({"code": "stream_not_found"}, status=404)
        return Response(producer.snapshot(stream))

    @extend_schema(
        operation_id="dyte_producer_v1_action",
        request=ProducerInstruction,
        responses={200: ProducerResult, 202: ProducerResult, **ERRORS},
    )
    def post(self, request, stream_id):
        return self.execute(request, stream_id)


class ProducerHistory(ProducerView):
    @extend_schema(
        operation_id="dyte_producer_v1_history",
        responses={200: ProducerStatus(many=True), **ERRORS},
    )
    def get(self, request):
        producer.authenticate(request.user, request.user.pk)
        streams = ProducerStream.objects.filter(creator=request.user).order_by(
            "-created_at"
        )[:30]
        return Response([producer.snapshot(stream) for stream in streams])

    http_method_names = ["get", "head", "options"]
