"""Signature-verification tests for the Dyte/RealtimeKit webhook.

Runs against real Postgres (project rule: never mock the DB). Only the
external boundaries are stubbed — the provider's public key (fetched over
HTTP at runtime) and Pub/Sub.

Two things are asserted here:

1. ``POST /api/dyte/webhook`` acts on a correctly-signed payload and rejects
   an unsigned, wrongly-signed or malformed-signature payload with a 400,
   never a 500 and never a side effect.
2. The legacy ``/api/dyte/webhook-recording-status-update/`` endpoint is kept
   ALIVE (the provider may still call it) but now runs the SAME signature
   check: unsigned/forged requests are rejected before it publishes anything
   to the DYTE_VIDEO_READY Pub/Sub topic, and a correctly-signed one is
   processed. Its SSRF sink is covered separately in test_recording_url.py.
"""
import base64
import json
import logging
import time
import uuid

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from dj.apps.dyte.models import BROADCAST, CreatorMeeting

WEBHOOK_URL = "/api/dyte/webhook"
DEPRECATED_URL = "/api/dyte/webhook-recording-status-update/"


@pytest.fixture(scope="module")
def keypair():
    # 2048-bit RSA, generated once per module: this is the slowest thing in
    # the file and every test wants the same key.
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return private_key, private_key.public_key()


@pytest.fixture(autouse=True)
def _stub_dyte_public_key(mocker, keypair):
    """Never let the tests reach out to the provider for the public key."""
    _, public_key = keypair
    mocker.patch(
        "dj.apps.dyte.views.get_or_load_dyte_public_key",
        return_value=public_key,
    )
    # Simulate a warm, RECENTLY loaded cache. The view reads this timestamp to
    # decide whether a non-verifying signature is a forgery (400) or possibly a
    # key rotation it could not re-check (503); see the 503 test below.
    mocker.patch(
        "dj.apps.dyte.views._DYTE_PUBLIC_KEY_LOADED_AT", time.monotonic())
    # The views no longer hold a Pub/Sub client: they write an outbox row
    #  and `jobs.outbox` is the single external boundary. Patch it
    # here as a MagicMock so `_publish_mock()` can count wire calls; the
    # root conftest's stub is a plain object with no call recording.
    mocker.patch("dj.apps.jobs.outbox.PubSubClient")


def _sign(private_key, payload: bytes) -> str:
    return base64.b64encode(
        private_key.sign(payload, padding.PKCS1v15(), hashes.SHA256())
    ).decode()


def _meeting_started_payload(meeting_id: str) -> bytes:
    """A minimal, schema-valid ``meeting.started`` event."""
    return json.dumps({
        "event": "meeting.started",
        "meeting": {
            "id": meeting_id,
            "sessionId": str(uuid.uuid4()),
            "title": "A stream",
            "status": "LIVE",
            "createdAt": "2026-07-19T00:00:00Z",
            "startedAt": "2026-07-19T00:00:00Z",
            "organizedBy": {"id": str(uuid.uuid4()), "name": "free2z"},
        },
    }).encode()


def _creator_meeting(creator_factory) -> CreatorMeeting:
    return CreatorMeeting.objects.create(
        creator=creator_factory(),
        meeting_id=str(uuid.uuid4()),
        meeting_type=BROADCAST,
        is_public=True,
        live_now=False,
    )


def _post(api_client, body: bytes, signature=None, event_id=None):
    extra = {"HTTP_DYTE_UUID": str(event_id or uuid.uuid4())}
    if signature is not None:
        extra["HTTP_DYTE_SIGNATURE"] = signature
    return api_client.post(
        WEBHOOK_URL, data=body, content_type="application/json", **extra
    )


# --------------------------------------------------------------------------
# The signed happy path — proves the fixture actually exercises the handler
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_correctly_signed_webhook_is_accepted_and_acted_on(
    api_client, creator_factory, keypair
):
    private_key, _ = keypair
    cm = _creator_meeting(creator_factory)
    body = _meeting_started_payload(cm.meeting_id)

    response = _post(api_client, body, _sign(private_key, body))

    assert response.status_code == 200, response.content
    cm.refresh_from_db()
    assert cm.live_now is True
    assert cm.last_seen_at is not None


# --------------------------------------------------------------------------
# Rejections — none of these may 500 and none may have a side effect
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_unsigned_webhook_is_rejected(api_client, creator_factory):
    cm = _creator_meeting(creator_factory)
    body = _meeting_started_payload(cm.meeting_id)

    response = _post(api_client, body)

    assert response.status_code == 400, response.content
    cm.refresh_from_db()
    assert cm.live_now is False


@pytest.mark.django_db
def test_webhook_signed_with_the_wrong_key_is_rejected(
    api_client, creator_factory
):
    attacker_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    cm = _creator_meeting(creator_factory)
    body = _meeting_started_payload(cm.meeting_id)

    response = _post(api_client, body, _sign(attacker_key, body))

    assert response.status_code == 400, response.content
    cm.refresh_from_db()
    assert cm.live_now is False


@pytest.mark.django_db
def test_webhook_signature_over_a_different_body_is_rejected(
    api_client, creator_factory, keypair
):
    """A valid signature does not authenticate a *substituted* payload."""
    private_key, _ = keypair
    cm = _creator_meeting(creator_factory)
    signed_body = _meeting_started_payload(str(uuid.uuid4()))
    tampered_body = _meeting_started_payload(cm.meeting_id)

    response = _post(api_client, tampered_body, _sign(private_key, signed_body))

    assert response.status_code == 400, response.content
    cm.refresh_from_db()
    assert cm.live_now is False


@pytest.mark.django_db
@pytest.mark.parametrize("signature", ["not-base64!!", "", "   ", "AAAA"])
def test_webhook_malformed_signature_is_rejected_not_500(
    api_client, creator_factory, signature
):
    """A hostile header must be a clean 400, never an uncaught exception."""
    cm = _creator_meeting(creator_factory)
    body = _meeting_started_payload(cm.meeting_id)

    response = _post(api_client, body, signature)

    assert response.status_code == 400, response.content
    cm.refresh_from_db()
    assert cm.live_now is False


@pytest.mark.django_db
def test_rtk_signature_header_is_also_accepted(
    api_client, creator_factory, keypair
):
    """The Cloudflare RealtimeKit rename of the header still verifies."""
    private_key, _ = keypair
    cm = _creator_meeting(creator_factory)
    body = _meeting_started_payload(cm.meeting_id)

    response = api_client.post(
        WEBHOOK_URL,
        data=body,
        content_type="application/json",
        HTTP_RTK_SIGNATURE=_sign(private_key, body),
        HTTP_RTK_UUID=str(uuid.uuid4()),
    )

    assert response.status_code == 200, response.content
    cm.refresh_from_db()
    assert cm.live_now is True


@pytest.mark.django_db
def test_stale_legacy_header_does_not_veto_a_valid_rtk_header(
    api_client, creator_factory, keypair
):
    """Mid-migration a proxy can attach both header names. A stale/garbage
    legacy header must not reject a delivery whose other header is valid."""
    private_key, _ = keypair
    cm = _creator_meeting(creator_factory)
    body = _meeting_started_payload(cm.meeting_id)

    response = api_client.post(
        WEBHOOK_URL,
        data=body,
        content_type="application/json",
        HTTP_DYTE_SIGNATURE=_sign(private_key, _meeting_started_payload(
            str(uuid.uuid4()))),
        HTTP_RTK_SIGNATURE=_sign(private_key, body),
        HTTP_RTK_UUID=str(uuid.uuid4()),
    )

    assert response.status_code == 200, response.content
    cm.refresh_from_db()
    assert cm.live_now is True


@pytest.mark.django_db
def test_both_headers_invalid_is_still_rejected(api_client, creator_factory):
    attacker_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    cm = _creator_meeting(creator_factory)
    body = _meeting_started_payload(cm.meeting_id)

    response = api_client.post(
        WEBHOOK_URL,
        data=body,
        content_type="application/json",
        HTTP_DYTE_SIGNATURE="not-base64!!",
        HTTP_RTK_SIGNATURE=_sign(attacker_key, body),
    )

    assert response.status_code == 400, response.content
    cm.refresh_from_db()
    assert cm.live_now is False


# --------------------------------------------------------------------------
# The legacy recording endpoint is ALIVE, but now signature-verified
# --------------------------------------------------------------------------


def _recording_payload(meeting_id):
    return json.dumps({
        "recording": {
            "status": "UPLOADED",
            "downloadUrl": "https://bucket.s3.amazonaws.com/rec.mp4",
        },
        "meeting": {"id": meeting_id},
    }).encode()


def _post_recording(api_client, body, signature=None, event_id=None):
    extra = {"HTTP_DYTE_UUID": str(event_id or uuid.uuid4())}
    if signature is not None:
        extra["HTTP_DYTE_SIGNATURE"] = signature
    return api_client.post(
        "/api/dyte/webhook-recording-status-update/",
        data=body, content_type="application/json", **extra
    )


@pytest.mark.django_db
def test_recording_endpoint_still_exists(api_client, creator_factory, keypair):
    """It must stay live — the provider may still be pointed at it, and a 404
    would silently drop recordings (unrecoverable: the URL expires).

    Asserted as the two answers the live route gives, not as "not 404"
    : that also passed on a 405, a 410 or an explicit 500, every one
    of which drops the recording just as surely.
    """
    private_key, _ = keypair
    cm = _creator_meeting(creator_factory)
    body = _recording_payload(cm.meeting_id)

    # Unsigned: the signature gate's own refusal -- a bodiless 400, answered
    # before any key fetch. A resolver 404 or a 405 carries a body.
    unsigned = _post_recording(api_client, body)
    assert unsigned.status_code == 400, unsigned.content
    assert unsigned.content == b"", unsigned.content

    # Signed: the delivery is accepted. This is the half that proves the
    # route reaches the handler and the handler still works.
    signed = _post_recording(api_client, body, _sign(private_key, body))
    assert signed.status_code == 200, signed.content


def _publish_mock():
    # The autouse fixture replaces dj.apps.jobs.outbox.PubSubClient with a
    # MagicMock; `ps = PubSubClient(); ps.publish(...)` records on this.
    from dj.apps.jobs import outbox
    return outbox.PubSubClient.return_value.publish


def _drain():
    """Run the relay the webhook's committed outbox row queues.

    Publication is no longer synchronous with the request, so a test that
    wants to see the message has to run the thing that sends it. A test that
    wants to see NO message runs this too -- otherwise "nothing published"
    would be true merely because nothing had drained yet.
    """
    from dj.apps.jobs import outbox
    return outbox.drain()


@pytest.mark.django_db
def test_recording_endpoint_rejects_unsigned_before_publishing(
    api_client, creator_factory
):
    publish = _publish_mock()
    cm = _creator_meeting(creator_factory)

    response = _post_recording(api_client, _recording_payload(cm.meeting_id))

    assert response.status_code == 400, response.content
    _drain()
    publish.assert_not_called()


@pytest.mark.django_db
def test_recording_endpoint_rejects_bad_signature_before_publishing(
    api_client, creator_factory
):
    publish = _publish_mock()
    attacker_key = rsa.generate_private_key(
        public_exponent=65537, key_size=2048)
    cm = _creator_meeting(creator_factory)
    body = _recording_payload(cm.meeting_id)

    response = _post_recording(api_client, body, _sign(attacker_key, body))

    assert response.status_code == 400, response.content
    _drain()
    publish.assert_not_called()


@pytest.mark.django_db
def test_recording_endpoint_processes_a_correctly_signed_payload(
    api_client, creator_factory, keypair
):
    private_key, _ = keypair
    publish = _publish_mock()
    cm = _creator_meeting(creator_factory)
    body = _recording_payload(cm.meeting_id)

    response = _post_recording(api_client, body, _sign(private_key, body))

    assert response.status_code == 200, response.content
    _drain()
    assert publish.call_count == 1
    _topic, msg = publish.call_args.args
    assert msg["username"] == cm.creator.username
    assert msg["url"] == "https://bucket.s3.amazonaws.com/rec.mp4"
    assert uuid.UUID(msg["provider_event_id"])


@pytest.mark.django_db
@pytest.mark.parametrize("url, payload", [
    (
        WEBHOOK_URL,
        {
            "event": "recording.statusUpdate",
            "meeting": {"id": "not-a-uuid"},
            "recording": {
                "status": "UPLOADED",
                "downloadUrl": None,
            },
        },
    ),
    (
        DEPRECATED_URL,
        {
            "meeting": {"id": "not-a-uuid"},
            "recording": {
                "status": "UPLOADED",
                "downloadUrl": None,
            },
        },
    ),
])
def test_invalid_recording_webhook_logs_exclude_rejected_input(
    api_client, keypair, caplog, url, payload,
):
    private_key, _ = keypair
    secret = "DISTINCT_INVALID_SIGNATURE_854"
    payload["recording"]["downloadUrl"] = (
        "https://user:password@bucket.s3.amazonaws.com/rec.mp4"
        f"?X-Amz-Signature={secret}"
    )
    body = json.dumps(payload).encode()

    with caplog.at_level(logging.ERROR, logger="dj.apps.dyte.views"):
        response = api_client.post(
            url,
            data=body,
            content_type="application/json",
            HTTP_DYTE_SIGNATURE=_sign(private_key, body),
            HTTP_DYTE_UUID=str(uuid.uuid4()),
        )

    assert response.status_code == 400
    assert secret not in caplog.text
    assert "user:password" not in caplog.text
    assert "uuid_parsing" in caplog.text


@pytest.mark.django_db
def test_signature_failure_triggers_a_key_refresh_and_retries(
    api_client, creator_factory, mocker
):
    """Provider key rotation must not silently drop real events.

    The provider does not retry 4xx, so rejecting on a stale key until the
    cache TTL expires would permanently lose every delivery in between.
    """
    from cryptography.hazmat.primitives import serialization as _ser

    from dj.apps.dyte import views as dyte_views

    stale = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    rotated = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    # Undo the module-level autouse stub: exercise the real cache path.
    mocker.stopall()
    mocker.patch("dj.apps.jobs.outbox.PubSubClient")
    dyte_views.reset_dyte_public_key_cache()

    def _resp(key):
        pem = key.public_key().public_bytes(
            encoding=_ser.Encoding.PEM,
            format=_ser.PublicFormat.SubjectPublicKeyInfo,
        ).decode()
        return mocker.Mock(
            status_code=200,
            raise_for_status=mocker.Mock(),
            json=mocker.Mock(return_value={"data": {"publicKey": pem}}),
        )

    get = mocker.patch(
        "dj.apps.dyte.views.requests.get", return_value=_resp(stale))
    clock = {"t": 1000.0}
    mocker.patch("dj.apps.dyte.views.time.monotonic",
                 side_effect=lambda: clock["t"])
    cm = _creator_meeting(creator_factory)
    body = _meeting_started_payload(cm.meeting_id)

    # Warm the cache with the soon-to-be-old key.
    assert dyte_views.get_or_load_dyte_public_key() is not None
    assert get.call_count == 1

    # The provider rotates and signs with the new key. Step past the shared
    # fetch back-off (default 30s) — that window is the deliberate price of
    # capping the amplification lever, and it bounds how long a rotation can
    # drop events.
    clock["t"] += 31
    get.return_value = _resp(rotated)
    response = _post(api_client, body, _sign(rotated, body))

    assert response.status_code == 200, response.content
    assert get.call_count == 2, "the failure should have forced a refresh"
    cm.refresh_from_db()
    assert cm.live_now is True

    dyte_views.reset_dyte_public_key_cache()


@pytest.mark.django_db
def test_forged_signature_still_rejected_after_a_refresh(
    api_client, creator_factory, mocker
):
    """The refresh path must not become a bypass."""
    from cryptography.hazmat.primitives import serialization as _ser

    from dj.apps.dyte import views as dyte_views

    real = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    attacker = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    mocker.stopall()
    mocker.patch("dj.apps.jobs.outbox.PubSubClient")
    dyte_views.reset_dyte_public_key_cache()

    pem = real.public_key().public_bytes(
        encoding=_ser.Encoding.PEM,
        format=_ser.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    mocker.patch(
        "dj.apps.dyte.views.requests.get",
        return_value=mocker.Mock(
            status_code=200,
            raise_for_status=mocker.Mock(),
            json=mocker.Mock(return_value={"data": {"publicKey": pem}}),
        ),
    )
    cm = _creator_meeting(creator_factory)
    body = _meeting_started_payload(cm.meeting_id)

    response = _post(api_client, body, _sign(attacker, body))

    assert response.status_code == 400, response.content
    cm.refresh_from_db()
    assert cm.live_now is False

    dyte_views.reset_dyte_public_key_cache()


@pytest.mark.django_db
def test_stale_key_that_cannot_be_rechecked_answers_503_not_400(
    api_client, creator_factory, mocker
):
    """A rotation we cannot confirm must be retryable, not discarded.

    The provider retries 5xx and does NOT retry 4xx. When the cached key is
    older than the back-off window and the refresh is rate-limited or failing,
    we genuinely cannot distinguish a forgery from a post-rotation delivery —
    so answer 503 and let the provider redeliver.
    """
    attacker = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    cm = _creator_meeting(creator_factory)
    body = _meeting_started_payload(cm.meeting_id)

    # Key loaded long ago, and the refresh is suppressed by the back-off.
    mocker.patch(
        "dj.apps.dyte.views._DYTE_PUBLIC_KEY_LOADED_AT",
        time.monotonic() - 100_000,
    )
    mocker.patch(
        "dj.apps.dyte.views._DYTE_PUBLIC_KEY_ATTEMPTED_AT", time.monotonic())

    response = _post(api_client, body, _sign(attacker, body))

    assert response.status_code == 503, response.content
    cm.refresh_from_db()
    assert cm.live_now is False


@pytest.mark.django_db
@pytest.mark.parametrize('legacy', [False, True])
@pytest.mark.parametrize('target_fault', [None, 'owner', 'public', 'deleted', 'session'])
def test_private_recording_delivery_survives_rotation_without_cache(
    api_client, creator_factory, keypair, mocker, legacy, target_fault,
):
    from decimal import Decimal
    from django.core.cache import cache
    from dj.apps.dyte import recording_control, views
    from dj.apps.dyte.models import PRIVATE, RecordingDeliveryTarget
    from dj.apps.dyte.management.commands.dyte_download_upload import resolve_recording_access

    private_key, _ = keypair
    creator = creator_factory(tuzis=Decimal('1000'))
    old_id = str(uuid.uuid4())
    cm = CreatorMeeting.objects.create(
        creator=creator, meeting_id=old_id, meeting_type=PRIVATE,
        is_public=False, e2ee=False, secret=uuid.uuid4(),
    )
    cache.clear()
    mocker.patch.object(recording_control, 'provider', return_value=None)
    def rotate(room):
        room.meeting_id = str(uuid.uuid4())
        room.save(update_fields=['meeting_id'])
        return room
    mocker.patch.object(views, '_create_meeting', side_effect=rotate)
    api_client.force_authenticate(creator)
    assert api_client.post(f'/api/dyte/{creator.username}/private', {}).status_code == 200
    api_client.force_authenticate(None)
    target = RecordingDeliveryTarget.objects.get(provider_meeting_id=old_id)
    assert target.creator_id_snapshot == creator.pk
    assert target.creator_meeting_id == cm.pk
    assert target.meeting_type == PRIVATE and not target.is_public
    if target_fault == 'owner':
        target.creator_id_snapshot = creator_factory().pk
        target.save(update_fields=['creator_id_snapshot'])
    elif target_fault == 'public':
        target.is_public = True
        target.save(update_fields=['is_public'])
    elif target_fault == 'session':
        target.provider_session_id = uuid.uuid4()
        target.save(update_fields=['provider_session_id'])
    elif target_fault == 'deleted':
        target.creator = None
        target.save(update_fields=['creator'])

    body = json.loads(_recording_payload(old_id))
    body['recording']['id'] = str(uuid.uuid4())
    if not legacy:
        body['event'] = 'recording.statusUpdate'
        body['meeting'] = json.loads(_meeting_started_payload(old_id))['meeting']
    raw = json.dumps(body).encode()
    post = _post_recording if legacy else _post
    response = post(api_client, raw, _sign(private_key, raw))
    assert response.status_code == 200, response.content
    _drain()
    publish = _publish_mock()
    if target_fault:
        publish.assert_not_called()
    else:
        assert publish.call_count == 1
        payload = publish.call_args.args[1]
        assert payload['creator_id'] == creator.pk
        assert payload['meeting_pk'] == cm.pk
        assert resolve_recording_access(payload, creator) == 'private'

    # Historical routing must not bring the retired room back to life.
    cm.refresh_from_db()
    cm.live_now = False
    cm.save(update_fields=['live_now'])
    started = _meeting_started_payload(old_id)
    assert _post(api_client, started, _sign(private_key, started)).status_code == 200
    cm.refresh_from_db()
    assert cm.live_now is False
