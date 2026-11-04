from rest_framework import serializers


class VerifyOTPSerializer(serializers.Serializer):
    token = serializers.CharField(max_length=10)

