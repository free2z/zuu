import logging
import jwt
import json
import base64
from datetime import datetime, timedelta, timezone
from django.shortcuts import get_object_or_404
from django.db import transaction
from django.http import HttpRequest
from django.conf import settings
from ninja import Router
from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    verify_registration_response,
    verify_authentication_response,
    base64url_to_bytes,
    options_to_json,
)
from webauthn.helpers.structs import (
    PublicKeyCredentialCreationOptions,
    # PublicKeyCredentialRequestOptions,
    UserVerificationRequirement,
    AttestationConveyancePreference,
    PublicKeyCredentialDescriptor,
    PublicKeyCredentialType,
)
from webauthn.helpers.exceptions import (
    InvalidRegistrationResponse,
    InvalidAuthenticationResponse,
)
from .models import FrostGroup, Participant, WebAuthnChallenge
from .schemas import (
    StartGroupRequest, StartGroupResponse,
    RegisterParticipantRequest,
    WebAuthnRegistrationRequest, WebAuthnRegistrationResponse,
    CreateAuthenticationChallengeRequest, CreateAuthenticationChallengeResponse,
    AuthenticateWebAuthnRequest, AuthenticateWebAuthnResponse,
    ErrorResponse,
)

logger = logging.getLogger(__name__)

JWT_SECRET = settings.SECRET_KEY
JWT_ALGORITHM = "HS256"
RP_NAME = "Free2Z EFM"


def get_rp_id(request: HttpRequest) -> str:
    """
    Generates the RP ID based on the incoming request.
    Removes the port if present.

    Args:
        request (HttpRequest): The incoming Django request object.

    Returns:
        str: The RP ID based on the request.
    """
    rpid = request.get_host().split(':')[0]
    if rpid == '127.0.0.1':
        rpid = 'localhost'
    return rpid


router = Router()


@router.post("/start-group", response=StartGroupResponse)
def start_group(request: HttpRequest, data: StartGroupRequest):
    """
    Create a new group and initiate
    a WebAuthn registration flow for the first participant.
    """
    logger.debug("Starting a new group")
    with transaction.atomic():
        group = FrostGroup.objects.create(max_participants=data.max_participants)
        participant = Participant.objects.create(group=group)

        registration_options: PublicKeyCredentialCreationOptions = generate_registration_options(
            rp_id=get_rp_id(request),
            rp_name=RP_NAME,
            user_name=str(participant.uuid),
            attestation=AttestationConveyancePreference.NONE,
            timeout=60000,
            authenticator_selection=None,
        )

        registration_challenge_json = options_to_json(registration_options)

        # Encode the challenge to base64url and store as string
        encoded_challenge = base64.urlsafe_b64encode(registration_options.challenge).decode('utf-8').rstrip('=')
        WebAuthnChallenge.objects.create(
            participant=participant,
            challenge=encoded_challenge,  # Store as base64url-encoded string
            challenge_type='registration',
        )

        logger.debug(f"Group created with ID: {group.uuid}")
        logger.debug(f"Participant created with ID: {participant.uuid}")
        logger.debug(f"Registration options: {registration_options}")
        logger.debug(f"Registration challenge (JSON): {registration_challenge_json}")

        return StartGroupResponse(
            group_id=group.uuid,
            participant_uuid=participant.uuid,
            registration_challenge=registration_challenge_json,
        )


@router.post("/register-participant", response={
    200: StartGroupResponse,
    400: ErrorResponse,
})
def register_participant(request: HttpRequest, data: RegisterParticipantRequest):
    """
    Registers a new participant in an existing group and initiates a WebAuthn registration flow.
    """
    logger.debug(f"Registering new participant in group {data.group_id}")

    group = get_object_or_404(FrostGroup, uuid=data.group_id)

    if group.participants.filter(
        webauthn_credential_id__isnull=False
    ).count() >= group.max_participants:
        logger.error("Max participants limit reached")
        return 400, ErrorResponse(error="Max participants limit reached").model_dump()

    with transaction.atomic():
        participant = Participant.objects.create(group=group)

        registration_options: PublicKeyCredentialCreationOptions = generate_registration_options(
            rp_id=get_rp_id(request),
            rp_name=RP_NAME,
            user_name=str(participant.uuid),
            attestation=AttestationConveyancePreference.NONE,
            timeout=60000,
            authenticator_selection=None,
        )

        registration_challenge_json = options_to_json(registration_options)
        encoded_challenge = base64.urlsafe_b64encode(
            registration_options.challenge).decode('utf-8').rstrip('=')

        WebAuthnChallenge.objects.create(
            participant=participant,
            challenge=encoded_challenge,
            challenge_type='registration',
        )

        logger.debug(f"New participant created with ID: {participant.uuid}")
        logger.debug(f"Registration options: {registration_options}")
        logger.debug(f"Registration challenge (JSON): {registration_challenge_json}")

        return StartGroupResponse(
            group_id=group.uuid,
            participant_uuid=participant.uuid,
            registration_challenge=registration_challenge_json,
        )


@router.post("/register-webauthn", response={
    200: WebAuthnRegistrationResponse,
    400: ErrorResponse,
})
def register_webauthn(request: HttpRequest, data: WebAuthnRegistrationRequest):
    logger.debug(f"Registering participant {data.participant_uuid} in group {data.group_id}")

    participant = get_object_or_404(
        Participant, uuid=data.participant_uuid, group__uuid=data.group_id
    )

    if participant.group.participants.filter(
        webauthn_credential_id__isnull=False
    ).count() >= participant.group.max_participants:
        logger.error("Max participants limit reached during registration")
        return 400, ErrorResponse(
            error="Max participants limit reached during registration"
        ).model_dump()

    with transaction.atomic():
        # Retrieve the registration challenge from the database
        challenge = get_object_or_404(
            WebAuthnChallenge,
            participant=participant,
            challenge_type='registration'
        )

        # Decode the stored base64url-encoded challenge back into bytes
        expected_challenge_bytes = base64.urlsafe_b64decode(challenge.challenge + '==')
        logger.debug(f"Expected registration challenge (decoded): {expected_challenge_bytes}")

        # Log the registration response for comparison
        logger.debug(f"Registration response received: {data.registration_response}")

        # Extract the client data JSON from the response and log it
        client_data_json_bytes = base64url_to_bytes(data.registration_response['response']['clientDataJSON'])
        client_data_json = json.loads(client_data_json_bytes)
        logger.debug(f"Client data JSON: {client_data_json}")

        # Extract the challenge from clientDataJSON and compare it with expected
        received_challenge = client_data_json.get('challenge')
        logger.debug(f"Received challenge from clientDataJSON: {received_challenge}")

        # Compare the expected and received challenges
        encoded_challenge_sent = base64.urlsafe_b64encode(expected_challenge_bytes).decode('utf-8').rstrip('=')
        logger.debug(f"Base64url-encoded expected challenge: {encoded_challenge_sent}")

        if encoded_challenge_sent != received_challenge:
            logger.error("Mismatch between expected challenge and received challenge")
            return 400, ErrorResponse(error="Challenge mismatch").model_dump()

        rp_id = get_rp_id(request)
        origin = request.build_absolute_uri('/').rstrip('/')
        # Hack to make it work locally
        if origin == "http://127.0.0.1:8000":
            origin = "https://localhost:3000"
        logger.debug(f"RP ID: {rp_id}")
        logger.debug(f"Origin: {origin}")

        try:
            # Perform verification using the received response
            verification_result = verify_registration_response(
                credential=data.registration_response,
                expected_challenge=expected_challenge_bytes,
                expected_origin=origin,
                expected_rp_id=rp_id,
            )
        except InvalidRegistrationResponse as e:
            logger.error(f"Registration verification failed: {str(e)}")
            return 400, ErrorResponse(error="Registration verification failed").model_dump()

        participant.webauthn_public_key = base64.urlsafe_b64encode(
            verification_result.credential_public_key
        ).decode('utf-8').rstrip('=')
        participant.webauthn_credential_id = base64.urlsafe_b64encode(
            verification_result.credential_id
        ).decode('utf-8').rstrip('=')
        participant.save()

        # Delete the used challenge to prevent reuse
        challenge.delete()
        logger.debug(f"Deleted registration challenge for participant {participant.uuid}")

        # Generate a JWT for subsequent authentication
        expiration = datetime.now(timezone.utc) + timedelta(hours=2)
        token = jwt.encode(
            {"participant_uuid": str(participant.uuid), "exp": expiration},
            JWT_SECRET,
            algorithm=JWT_ALGORITHM
        )

    return WebAuthnRegistrationResponse(
        group_id=participant.group.uuid,
        participant_uuid=participant.uuid,
        webauthn_credential_id=participant.webauthn_credential_id,
        token=token,
        n=participant.group.max_participants,
    )


@router.post("/create-authentication-challenge", response={
    200: CreateAuthenticationChallengeResponse,
    400: ErrorResponse,
})
def create_authentication_challenge(
    request: HttpRequest, data: CreateAuthenticationChallengeRequest
):
    """
    Creates a new WebAuthn authentication challenge for an existing participant.
    """
    logger.debug(
        f"Creating auth challenge: {data.participant_uuid} in {data.group_id}")

    participant = get_object_or_404(
        Participant, uuid=data.participant_uuid, group__uuid=data.group_id
    )

    if not participant.webauthn_credential_id:
        logger.error("Participant does not have a registered WebAuthn credential")
        return 400, ErrorResponse(
            error="Participant does not have a registered WebAuthn credential"
        ).model_dump()

    allow_credentials = [
        PublicKeyCredentialDescriptor(
            type=PublicKeyCredentialType.PUBLIC_KEY,
            id=base64.urlsafe_b64decode(participant.webauthn_credential_id + '=='),
        )
    ]

    # Generate authentication options using the stored credential ID
    authentication_options = generate_authentication_options(
        rp_id=get_rp_id(request),
        allow_credentials=allow_credentials,
        user_verification=UserVerificationRequirement.PREFERRED,
        timeout=60000,
    )

    resp = CreateAuthenticationChallengeResponse(
        group_id=participant.group.uuid,
        participant_uuid=participant.uuid,
        authentication_challenge=options_to_json(authentication_options)
    )

    # Convert challenge to base64url and store it
    challenge_base64url = base64.urlsafe_b64encode(
        authentication_options.challenge).decode('utf-8').rstrip('=')
    WebAuthnChallenge.objects.filter(
        participant=participant, challenge_type='authentication'
    ).delete()
    WebAuthnChallenge.objects.create(
        participant=participant,
        challenge=challenge_base64url,
        challenge_type='authentication',
    )
    logger.debug(f"Authentication options: {options_to_json(authentication_options)}")
    logger.debug(f"Stored authentication challenge (base64url): {challenge_base64url}")
    return resp


@router.post("/authenticate-webauthn", response={
    200: AuthenticateWebAuthnResponse,
    400: ErrorResponse,
})
def authenticate_webauthn(
    request: HttpRequest, data: AuthenticateWebAuthnRequest
):
    """
    Authenticates a participant using their WebAuthn credentials.
    """
    logger.debug(
        f"Authenticating participant {data.participant_uuid} in group {data.group_id}")

    participant = get_object_or_404(
        Participant, uuid=data.participant_uuid, group__uuid=data.group_id
    )

    # Retrieve the authentication challenge from the database
    challenge = get_object_or_404(
        WebAuthnChallenge,
        participant=participant,
        challenge_type='authentication'
    )

    # Decode the stored base64url-encoded challenge back into bytes
    expected_challenge_bytes = base64.urlsafe_b64decode(challenge.challenge + '==')
    logger.debug(
        f"Expected authentication challenge (decoded): {expected_challenge_bytes}")

    rp_id = get_rp_id(request)
    origin = request.build_absolute_uri('/').rstrip('/')
    # Hack to make it work locally
    if origin == "http://127.0.0.1:8000":
        origin = "https://localhost:3000"
    logger.debug(f"RP ID: {rp_id}")
    logger.debug(f"Origin: {origin}")

    logger.debug(f"webauthn_public_key: {participant.webauthn_public_key}")
    logger.debug(f"webauthn_public_key bytes: {base64.urlsafe_b64decode(participant.webauthn_public_key + '==')}")

    try:
        # Perform verification using the received response
        verification_result = verify_authentication_response(
            credential=data.authentication_response,
            expected_challenge=expected_challenge_bytes,
            expected_origin=origin,
            expected_rp_id=rp_id,
            credential_public_key=base64.urlsafe_b64decode(participant.webauthn_public_key + "=="),
            credential_current_sign_count=participant.sign_count,
        )
        logger.debug(f"Verification success: {participant.uuid}")
        logger.debug(f"Verification result: {verification_result}")

    except InvalidAuthenticationResponse as e:
        logger.error(f"Authentication failed: {str(e)}")
        return 400, ErrorResponse(error="Authentication failed").model_dump()

    # Generate a new JWT token for the authenticated participant
    expiration = datetime.now(timezone.utc) + timedelta(hours=2)
    token = jwt.encode(
        {"participant_uuid": str(participant.uuid), "exp": expiration},
        JWT_SECRET,
        algorithm=JWT_ALGORITHM
    )

    # Delete the used challenge to prevent reuse
    challenge.delete()
    logger.debug(
        f"Deleted authentication challenge for participant {participant.uuid}")

    return AuthenticateWebAuthnResponse(
        group_id=participant.group.uuid,
        participant_uuid=participant.uuid,
        token=token,
        n=participant.group.max_participants,
    )
