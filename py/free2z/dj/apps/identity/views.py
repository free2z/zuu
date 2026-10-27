"""First-party browser step-up completion check."""
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .auth_context import require_recent_auth


class RecentAuthenticationView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: inline_serializer(
        name="RecentAuthenticationResponse",
        fields={"username": serializers.CharField()},
    )})
    def get(self, request):
        require_recent_auth(request)
        response = Response({"username": request.user.username})
        response["Cache-Control"] = "no-store"
        return response
