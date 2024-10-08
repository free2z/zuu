from pydantic import BaseModel, Field, UUID4
from typing import Dict, Any


class StartGroupRequest(BaseModel):
    max_participants: int = Field(
        ..., ge=1, le=100,
        description="The maximum number of participants allowed in the group",
    )


class StartGroupResponse(BaseModel):
    group_id: UUID4 = Field(
        ..., description="The unique identifier of the newly created group")
    participant_uuid: UUID4 = Field(
        ..., description="The unique identifier for the participant creating the group")
    registration_challenge: str = Field(
        ..., description="The WebAuthn registration challenge for the participant")

    class Config:
        json_schema_extra = {
            "example": {
                "group_id": "7e336ac1-b8a3-490a-8b4f-3e4c5e79536b",
                "participant_uuid": "91c66aa4-e9bd-463c-8037-2d6d39da0363",
                "registration_challenge": "YWFpZjRvSG1uM0p0UFBXSGdaeHZMbzNwX0JhNTBhVUJqU2NEd05BLWk2TXZ4eEJsRHNFTlJxSHBSbE5DUVR2X1FFVXhOVmczeFJpMm9VbnNDOXpzUlE"
            }
        }


class WebAuthnRegistrationRequest(BaseModel):
    group_id: UUID4
    participant_uuid: UUID4
    registration_response: Dict[str, Any]  # The response from the client during registration


class WebAuthnRegistrationResponse(BaseModel):
    group_id: UUID4
    participant_uuid: UUID4
    webauthn_credential_id: str
    token: str
    n: int


class RegisterParticipantRequest(BaseModel):
    group_id: UUID4


class CreateAuthenticationChallengeRequest(BaseModel):
    group_id: UUID4 = Field(
        ..., description="The unique identifier of the group the participant belongs to"
    )
    participant_uuid: UUID4 = Field(
        ..., description="The unique identifier of the participant requesting authentication"
    )


class CreateAuthenticationChallengeResponse(BaseModel):
    group_id: UUID4 = Field(
        ..., description="The unique identifier of the group the participant belongs to"
    )
    participant_uuid: UUID4 = Field(
        ..., description="The unique identifier of the participant requesting authentication"
    )
    authentication_challenge: str = Field(
        ..., description="The base64url-encoded WebAuthn authentication challenge for the participant"
    )


class AuthenticateWebAuthnRequest(BaseModel):
    """
    Request schema for authenticating a participant using WebAuthn credentials.
    """
    group_id: UUID4 = Field(..., description="The unique identifier of the group")
    participant_uuid: UUID4 = Field(..., description="The unique identifier of the participant")
    authentication_response: Dict[str, Any] = Field(
        ..., description="The WebAuthn authentication response from the client"
    )


class AuthenticateWebAuthnResponse(BaseModel):
    """
    Response schema for successful authentication of a participant using WebAuthn credentials.
    """
    group_id: UUID4 = Field(..., description="The unique identifier of the group")
    participant_uuid: UUID4 = Field(..., description="The unique identifier of the authenticated participant")
    token: str = Field(..., description="JWT token issued upon successful authentication")
    n: int = Field(..., description="The max number of participants in the group")


class ErrorResponse(BaseModel):
    error: str

    class Config:
        json_schema_extra = {
            "example": {
                "error": "Description of the error"
            }
        }
