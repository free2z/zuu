import uuid
from django.db import models
from datetime import timedelta
from django.utils import timezone


class FrostGroup(models.Model):
    uuid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    max_participants = models.PositiveIntegerField(default=5)

    def __str__(self):
        return f"FrostGroup {self.uuid} (Max: {self.max_participants})"


class Participant(models.Model):
    uuid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    group = models.ForeignKey(
        FrostGroup,
        related_name='participants',
        on_delete=models.CASCADE,
        help_text="The group to which this participant belongs."
    )
    webauthn_public_key = models.TextField(
        help_text="The WebAuthn public key associated with this participant, used for authentication."
    )
    webauthn_credential_id = models.TextField(
        unique=True, null=True, blank=True,
        help_text="A unique identifier for the WebAuthn credential, ensuring secure reference to the participant's credential."
    )
    # WebAuthn's signature counter is a **uint32** (authenticatorData bytes
    # 33-36, WebAuthn L2 6.1), so it ranges up to 4294967295. A
    # PositiveIntegerField is a Postgres `integer`, which tops out at
    # 2147483647 -- fine while nothing ever wrote this column, but now that
    # the verified counter is persisted  a device reporting a counter
    # in the top half of the uint32 range would raise on save and turn a
    # perfectly valid authentication into a 500. Some authenticators do
    # report implausibly large counters. Big enough to hold the whole domain.
    sign_count = models.PositiveBigIntegerField(
        default=0,
        help_text=(
            "The WebAuthn signature counter (uint32) last reported by this "
            "participant's authenticator. Only ever moves forward; an "
            "assertion whose counter fails to advance is rejected. A "
            "permanent 0 means the authenticator does not implement the "
            "counter, which is normal and is not a clone."
        ),
    )

    class Meta:
        verbose_name = "Participant"
        verbose_name_plural = "Participants"

    def __str__(self):
        return f"{self.uuid} in Group {self.group.uuid}"


class WebAuthnChallenge(models.Model):
    uuid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    participant = models.ForeignKey(
        Participant,
        on_delete=models.CASCADE,
        related_name='challenges',
        help_text="The participant to whom this WebAuthn challenge was issued."
    )
    challenge = models.TextField()
    challenge_type = models.CharField(
        max_length=20,
        help_text="The type of WebAuthn challenge, either 'registration' or 'authentication'."
    )
    created_at = models.DateTimeField(
        auto_now_add=True,
        help_text="The timestamp when this challenge was created. Used for challenge expiration and auditing."
    )

    def is_expired(self, ttl: int = 300) -> bool:
        """
        Check if the challenge has expired. The default TTL is 5 minutes (300 seconds).
        """
        expiration_time = self.created_at + timedelta(seconds=ttl)
        return timezone.now() > expiration_time

    def __str__(self):
        return f"Challenge {self.challenge_type} for participant in group {self.participant.group.uuid}"
