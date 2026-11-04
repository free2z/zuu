"""
Pydantic types for working with Dyte.
"""
from typing import Optional
from pydantic import (
    AliasChoices, BaseModel, Field, HttpUrl, UUID4, model_validator,
)
from datetime import datetime


class OrganizedBy(BaseModel):
    id: UUID4
    name: str


class Participant(BaseModel):
    peerId: UUID4
    userDisplayName: str
    customParticipantId: Optional[str] = Field(
        None,
        validation_alias=AliasChoices(
            'customParticipantId', 'clientSpecificId',
        ),
    )
    joinedAt: Optional[datetime] = None
    leftAt: Optional[datetime] = None


class Recording(BaseModel):
    id: UUID4
    status: str
    fileSize: Optional[int] = None
    roomUUID: Optional[UUID4] = None
    meetingId: Optional[UUID4] = None
    downloadUrl: Optional[HttpUrl] = None
    recordingId: Optional[UUID4] = None
    startedTime: Optional[datetime] = None
    stoppedTime: Optional[datetime] = None
    organizationId: Optional[UUID4] = None
    outputFileName: Optional[str] = None
    audioDownloadUrl: Optional[HttpUrl] = None
    downloadUrlExpiry: Optional[datetime] = None


class Meeting(BaseModel):
    id: UUID4
    sessionId: UUID4
    title: str
    status: str
    createdAt: datetime
    startedAt: datetime
    endedAt: Optional[datetime] = None
    organizedBy: OrganizedBy
    # participant: Optional[Participant] = None


class RecordingMeeting(Meeting):
    """Custom recorder callbacks can omit the provider's session metadata."""

    sessionId: Optional[UUID4] = None
    startedAt: Optional[datetime] = None


class WebhookEvent(BaseModel):
    event: str
    meeting: Meeting | RecordingMeeting
    reason: Optional[str] = None
    recording: Optional[Recording] = None
    participant: Optional[Participant] = None

    @model_validator(mode='after')
    def validate_event_specific_payload(self):
        if self.event != 'recording.statusUpdate' and (
            self.meeting.sessionId is None or self.meeting.startedAt is None
        ):
            raise ValueError(
                'non-recording events require meeting sessionId and startedAt')
        if self.event == 'meeting.participantLeft':
            participant = self.participant
            if (
                participant is None
                or participant.joinedAt is None
                or participant.leftAt is None
                or participant.customParticipantId is None
            ):
                raise ValueError(
                    'meeting.participantLeft requires participant identity '
                    'and join/leave timestamps'
                )
        if self.event == 'recording.statusUpdate' and self.recording is None:
            raise ValueError(
                'recording.statusUpdate requires recording details')
        return self


class LegacyWebhookMeeting(BaseModel):
    id: UUID4


class LegacyWebhookRecording(BaseModel):
    id: Optional[UUID4] = None
    status: str
    downloadUrl: Optional[HttpUrl] = None


class LegacyRecordingWebhookEvent(BaseModel):
    """Validated shape accepted by the retained recording-only endpoint."""

    meeting: LegacyWebhookMeeting
    recording: LegacyWebhookRecording
