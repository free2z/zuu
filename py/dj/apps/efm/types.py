from pydantic import BaseModel
from typing import Optional, Dict, Literal


# Updated Participant model with specific allowed values for websocketState
class Participant(BaseModel):
    uuid: str
    name: str
    channel_name: Optional[str] = None
    websocketState: bool


# Base class for all WebSocket messages
class WebSocketMessage(BaseModel):
    type: str


# Message for joining the session
class JoinMessage(WebSocketMessage):
    type: str = "join"
    token: str
    name: str
    uuid: str


# Message for changing a participant's name
class ChangeNameMessage(WebSocketMessage):
    type: str = "change_name"
    uuid: str
    name: str


# Message for signaling (offer/answer/ICE candidate)
class SignalingMessage(WebSocketMessage):
    type: str
    target: str
    source: str
    sdp: Optional[str] = None  # SDP message, used during offer/answer
    candidate: Optional[Dict] = None  # ICE candidate message


# Message for updating participants in the session
class UpdateParticipantsMessage(WebSocketMessage):
    type: str = "update_participants"
    participants: Dict[str, Participant]  # Mapping UUID to Participant objects


# Message for indicating that a participant's name has changed
class NameChangedMessage(WebSocketMessage):
    type: str = "name_changed"
    uuid: str
    name: str


# Error message response structure
class ErrorResponse(WebSocketMessage):
    type: str = "error"
    error: str
    details: Optional[str] = None
