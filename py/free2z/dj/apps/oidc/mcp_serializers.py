"""Public shapes for browser consent and MCP connection management."""
from rest_framework import serializers


class MCPApplicationSerializer(serializers.Serializer):
    name = serializers.CharField()
    client_id = serializers.CharField()


class MCPAccountSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    username = serializers.CharField()
    scopes = serializers.ListField(child=serializers.CharField())
    revoked = serializers.BooleanField()
    available = serializers.BooleanField()


class MCPConnectionSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    application = MCPApplicationSerializer()
    primary_username = serializers.CharField()
    scopes = serializers.ListField(child=serializers.CharField())
    accounts = MCPAccountSerializer(many=True)
    revoked = serializers.BooleanField()
    available = serializers.BooleanField()


class MCPAccountGrantSerializer(MCPAccountSerializer):
    connection_id = serializers.UUIDField()
    primary_username = serializers.CharField()
    application = MCPApplicationSerializer()


class MCPActionSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    operation = serializers.CharField()
    status = serializers.IntegerField()
    created_at = serializers.DateTimeField()
    primary_username = serializers.CharField(allow_null=True)
    target_username = serializers.CharField(allow_null=True)
    application = serializers.CharField(allow_null=True)


class MCPConnectionsSerializer(serializers.Serializer):
    connections = MCPConnectionSerializer(many=True)
    account_grants = MCPAccountGrantSerializer(many=True)
    recent_actions = MCPActionSerializer(many=True)


class MCPIntentSerializer(serializers.Serializer):
    intent = serializers.CharField(min_length=43, max_length=43, write_only=True)


class MCPLinkDecisionSerializer(MCPIntentSerializer):
    allow = serializers.BooleanField()
    scopes = serializers.ListField(child=serializers.CharField(), required=False)


class MCPLinkConnectionSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    primary_username = serializers.CharField()


class MCPLinkEvaluationSerializer(serializers.Serializer):
    expected_username = serializers.CharField()
    signed_in_username = serializers.CharField()
    account_matches = serializers.BooleanField()
    application = MCPApplicationSerializer()
    connection = MCPLinkConnectionSerializer()
    scopes = serializers.ListField(child=serializers.CharField())
    scope_descriptions = serializers.DictField(child=serializers.CharField())
    expires_at = serializers.DateTimeField()


class MCPLinkResultSerializer(serializers.Serializer):
    linked = serializers.BooleanField()
    account = MCPAccountSerializer(required=False)


class MCPRegistrationResultSerializer(serializers.Serializer):
    client_id = serializers.CharField()
    client_id_issued_at = serializers.IntegerField()
    client_name = serializers.CharField()
    redirect_uris = serializers.ListField(child=serializers.CharField())
    token_endpoint_auth_method = serializers.CharField()
    grant_types = serializers.ListField(child=serializers.CharField())
    response_types = serializers.ListField(child=serializers.CharField())
    scope = serializers.CharField()
    client_secret = serializers.CharField(required=False)
    client_secret_expires_at = serializers.IntegerField(required=False)
