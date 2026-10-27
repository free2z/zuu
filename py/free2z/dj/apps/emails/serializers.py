from django.contrib.auth.password_validation import validate_password

from rest_framework import serializers
from .models import Email

class EmailSerializer(serializers.ModelSerializer):
    class Meta:
        model = Email
        fields = [
            'email', 'token', 'created_at', 'expires_at', 'confirmed_at']
        read_only_fields = ['token', 'created_at', 'expires_at', 'confirmed_at']

    def create(self, validated_data):
        # Assume that 'user' is passed as context in the view
        user = self.context['request'].user
        return Email.objects.create(user=user, **validated_data)


class ChangePasswordSerializer(serializers.Serializer):
    old_password = serializers.CharField(required=False)
    new_password = serializers.CharField(required=True)
    otp_token = serializers.CharField(
        required=False,
        write_only=True,
        max_length=10,
        help_text="Current authenticator code for an account with MFA.",
    )

    def validate_new_password(self, value):
        validate_password(value)
        return value

    def validate_old_password(self, value):
        user = self.context['request'].user
        if user.has_usable_password() and not user.check_password(value):
            raise serializers.ValidationError("Incorrect password.")
        return value

    def validate(self, data):
        user = self.context['request'].user
        if user.has_usable_password() and 'old_password' not in data:
            raise serializers.ValidationError({"old_password": "This field is required."})
        return data
