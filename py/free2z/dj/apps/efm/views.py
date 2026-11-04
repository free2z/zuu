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
from .webauthn_config import get_expected_origins, get_rp_id, get_rp_name
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

# The relying-party ID and the expected origin used to be read off the
# incoming request (`request.get_host()` / `request.build_absolute_uri('/')`).
# They are the binding a passkey is verified against immediately before its
# public key is persisted, so the `Host` header was choosing what got written
#. They are configuration now -- see dj/apps/efm/webauthn_config.py and
# the WEBAUTHN_* block in dj/free2z/settings.py. Nothing below reads the
# request for either value, and there is no fallback if the config is absent.

# The one event an operator should alert on: a cryptographically valid
# assertion whose signature counter failed to advance, which WebAuthn L2 6.1.1
# calls a signal that the authenticator may have been cloned (or that an
# assertion was replayed). It should never fire in normal operation.
#
# The value is a stable, literal `jsonPayload.event` -- the log-based metric
# `webauthn_sign_count_regression` and the alert policy
# `monitoring/alert-policies/webauthn-sign-count-regression.json` both key off
# it, so renaming it here silently breaks the alert. See.
SIGN_COUNT_REGRESSION_EVENT = "webauthn_sign_count_regression"

router = Router()


def _log_sign_count_regression(participant, stored, presented):
    """Emit one-line JSON that Cloud Logging turns into ``jsonPayload``.

    Same shape as the sitemap events in dj/apps/g12f/views/sitemap.py: this
    deployment has no structured-logging handler, so a JSON *message* is how a
    log-based metric gets fields it can filter and group on. No credential
    material or public key goes in -- just the identifiers needed to find the
    participant and the two numbers that disagree.
    """
    logger.warning(json.dumps(
        {
            "severity": "WARNING",
            "message": (
                "WebAuthn signature counter did not advance; "
                "the authenticator may be cloned or the assertion replayed"
            ),
            "event": SIGN_COUNT_REGRESSION_EVENT,
            "outcome": "rejected",
            "participant_uuid": str(participant.uuid),
            "group_uuid": str(participant.group_id),
            "stored_sign_count": stored,
            "presented_sign_count": presented,
        },
        separators=(",", ":"),
    ))


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
            rp_id=get_rp_id(),
            rp_name=get_rp_name(),
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
            rp_id=get_rp_id(),
            rp_name=get_rp_name(),
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

        rp_id = get_rp_id()
        expected_origins = get_expected_origins()
        logger.debug(f"RP ID: {rp_id}")
        logger.debug(f"Expected origins: {expected_origins}")

        try:
            # Perform verification using the received response
            verification_result = verify_registration_response(
                credential=data.registration_response,
                expected_challenge=expected_challenge_bytes,
                expected_origin=expected_origins,
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
        # WebAuthn L2 7.1 step 22: the credential record's signature counter is
        # seeded from the *registration* authenticatorData, not left at 0. An
        # authenticator that implements the counter may well already be past 0
        # when it mints this credential, and seeding it means the very first
        # assertion is compared against the right baseline.
        participant.sign_count = verification_result.sign_count
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

    # Same participant lock the authentication ceremony takes. "One
    # authentication challenge per participant" is an invariant the
    # authenticate view depends on (it fetches the challenge with `get`, so a
    # second row is a 500, not a fallback), and delete-then-create is not
    # atomic on its own: two concurrent calls can both delete before either
    # inserts, leaving two rows and wedging every subsequent authentication
    # until a later single call happens to repair it.
    with transaction.atomic():
        participant = get_object_or_404(
            Participant.objects.select_for_update(of=("self",)),
            uuid=data.participant_uuid,
            group__uuid=data.group_id,
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
            rp_id=get_rp_id(),
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
        # The serialized options and stored challenge are authentication
        # material; recording either would turn application logs into a
        # credential store.
        logger.debug("WebAuthn authentication challenge created")
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

    # Everything from here to the challenge delete runs inside one
    # transaction with the participant row locked. The whole ceremony is
    # per-participant serialised, which is what makes the counter comparison
    # and the one-time use of the challenge mean anything: without the lock,
    # two copies of the same assertion can both read the same stored counter
    # and the same undeleted challenge, both verify, and both mint a token --
    # and for a counter-less authenticator (the 0/0 case below) the counter
    # cannot catch that, so the challenge has to. An ECDSA verification is
    # sub-millisecond; the lock is not a throughput concern.
    with transaction.atomic():
        participant = get_object_or_404(
            Participant.objects.select_for_update(of=("self",)),
            uuid=data.participant_uuid,
            group__uuid=data.group_id,
        )

        # Retrieve the authentication challenge from the database. Read under
        # the lock: a concurrent request that got here first has already
        # deleted it, and this one must see that rather than a stale copy.
        challenge = get_object_or_404(
            WebAuthnChallenge,
            participant=participant,
            challenge_type='authentication'
        )

        # Decode the stored base64url-encoded challenge back into bytes
        expected_challenge_bytes = base64.urlsafe_b64decode(challenge.challenge + '==')
        logger.debug(
            f"Expected authentication challenge (decoded): {expected_challenge_bytes}")

        rp_id = get_rp_id()
        expected_origins = get_expected_origins()
        logger.debug(f"RP ID: {rp_id}")
        logger.debug(f"Expected origins: {expected_origins}")

        logger.debug(f"webauthn_public_key: {participant.webauthn_public_key}")
        logger.debug(f"webauthn_public_key bytes: {base64.urlsafe_b64decode(participant.webauthn_public_key + '==')}")

        try:
            # Perform verification using the received response
            verification_result = verify_authentication_response(
                credential=data.authentication_response,
                expected_challenge=expected_challenge_bytes,
                expected_origin=expected_origins,
                expected_rp_id=rp_id,
                credential_public_key=base64.urlsafe_b64decode(participant.webauthn_public_key + "=="),
                # Deliberately 0, which is py_webauthn's "no counter known"
                # value and disables its own counter check. That check is not
                # skipped -- it is done below instead, because py_webauthn
                # 2.2.0 runs it *before* verifying the signature, inverting
                # WebAuthn L2 7.2 steps 19-21. In the library's order anyone
                # who knows a participant UUID could raise a clone alarm with
                # a garbage assertion; in the spec's order a regression is
                # only ever reported for an assertion that carried a valid
                # signature, which is the difference between an alert worth
                # paging on and noise.
                credential_current_sign_count=0,
            )
            logger.debug(f"Verification success: {participant.uuid}")
            logger.debug(f"Verification result: {verification_result}")

        except InvalidAuthenticationResponse as e:
            logger.error(f"Authentication failed: {str(e)}")
            return 400, ErrorResponse(error="Authentication failed").model_dump()

        presented_sign_count = verification_result.new_sign_count
        stored_sign_count = participant.sign_count

        # WebAuthn L2 7.2 step 21, and the reason this is not a plain `<=`:
        # an authenticator that does not implement the signature counter
        # reports 0 on every assertion, forever. That is not a rarity, it is
        # the common case -- Touch ID, Windows Hello and most other platform
        # authenticators never advance it. 0 <= 0 is therefore NOT a clone,
        # and treating it as one would lock out the majority of real users
        # while catching nobody. The counter is only meaningful once at least
        # one of the two values is non-zero, which is what the first clause
        # says.
        if (
            (presented_sign_count or stored_sign_count)
            and presented_sign_count <= stored_sign_count
        ):
            # Policy: reject, and burn the challenge.
            #
            # The spec only says the RP "SHOULD" fail the ceremony, and it
            # names authenticator malfunction and out-of-order processing as
            # legitimate causes besides cloning -- so a hard reject can in
            # principle wedge a genuine device whose counter reset from N to
            # 0. Rejecting anyway, for two reasons specific to this app: the
            # credential authorises FROST threshold signing, and a Participant
            # is a per-session row (a fresh one is created for every group
            # session, and the JWT lives 2h), so "wedged" means "start a new
            # session", not "lost your account". An operator can also clear
            # `sign_count` in the admin.
            #
            # Deleting the challenge matters as much as the 400: an attacker
            # holding one stale-but-validly-signed assertion could otherwise
            # replay that exact POST forever, burning a signature check and
            # emitting a compromise alert every time.
            _log_sign_count_regression(
                participant, stored_sign_count, presented_sign_count)
            challenge.delete()
            # Same opaque error the other failures return: the client learns
            # nothing about which check tripped. The detail is in the log.
            return 400, ErrorResponse(error="Authentication failed").model_dump()

        # Persist the verified counter -- the step whose absence made the
        # check above structurally unable to fire. Only ever forward:
        # the equal-and-zero case falls through here with nothing to write.
        if presented_sign_count > stored_sign_count:
            participant.sign_count = presented_sign_count
            participant.save(update_fields=["sign_count"])

        # Delete the used challenge to prevent reuse
        challenge.delete()
        logger.debug(
            f"Deleted authentication challenge for participant {participant.uuid}")

    # Generate a new JWT token for the authenticated participant
    expiration = datetime.now(timezone.utc) + timedelta(hours=2)
    token = jwt.encode(
        {"participant_uuid": str(participant.uuid), "exp": expiration},
        JWT_SECRET,
        algorithm=JWT_ALGORITHM
    )

    return AuthenticateWebAuthnResponse(
        group_id=participant.group.uuid,
        participant_uuid=participant.uuid,
        token=token,
        n=participant.group.max_participants,
    )
