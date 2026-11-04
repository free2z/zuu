"""Real-Postgres regressions for provider webhook delivery idempotency."""
import base64
import json
import logging
import re
import threading
import time
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from decimal import Decimal
from unittest.mock import patch

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from django.db import close_old_connections
from django.utils import timezone
from rest_framework.test import APIClient

from dj.apps.dyte.models import CreatorMeeting, WebhookDelivery
from dj.apps.events.models import Event
from dj.apps.jobs import outbox as outbox_module

WEBHOOK_URL = '/api/dyte/webhook'
LEGACY_URL = '/api/dyte/webhook-recording-status-update/'


@pytest.fixture(scope='module')
def keypair():
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return private_key, private_key.public_key()


@pytest.fixture(autouse=True)
def webhook_boundaries(mocker, keypair):
    _, public_key = keypair
    mocker.patch(
        'dj.apps.dyte.views.get_or_load_dyte_public_key',
        return_value=public_key,
    )
    mocker.patch(
        'dj.apps.dyte.views._DYTE_PUBLIC_KEY_LOADED_AT', time.monotonic())
    # The view no longer holds a Pub/Sub client. it writes an
    # outbox row inside the webhook's transaction and `jobs.outbox` is the
    # single external boundary, so that is what a test patches and counts.
    return mocker.patch('dj.apps.jobs.outbox.PubSubClient')


def _sign(private_key, body):
    return base64.b64encode(private_key.sign(
        body, padding.PKCS1v15(), hashes.SHA256(),
    )).decode()


def _meeting(meeting_id):
    return {
        'id': meeting_id,
        'sessionId': str(uuid.uuid4()),
        'title': 'Paid stream',
        'status': 'LIVE',
        'createdAt': '2026-07-21T00:00:00Z',
        'startedAt': '2026-07-21T00:00:00Z',
        'organizedBy': {'id': str(uuid.uuid4()), 'name': 'free2z'},
    }


def _participant_left_payload(
    cm, participant, identity_key='customParticipantId',
):
    return json.dumps({
        'event': 'meeting.participantLeft',
        'meeting': _meeting(cm.meeting_id),
        'participant': {
            'peerId': str(uuid.uuid4()),
            'userDisplayName': participant.username,
            identity_key: participant.username,
            'joinedAt': '2026-07-21T00:00:00Z',
            'leftAt': '2026-07-21T00:01:01Z',
        },
    }).encode()


def _recording_payload(cm):
    return json.dumps({
        'event': 'recording.statusUpdate',
        'meeting': _meeting(cm.meeting_id),
        'recording': {
            'id': str(uuid.uuid4()),
            'status': 'UPLOADED',
            'downloadUrl': 'https://bucket.s3.amazonaws.com/recording.mp4',
        },
    }).encode()


def _legacy_recording_payload(cm):
    return json.dumps({
        'meeting': {'id': cm.meeting_id},
        'recording': {
            'status': 'UPLOADED',
            'downloadUrl': 'https://bucket.s3.amazonaws.com/legacy.mp4',
        },
    }).encode()


def _post(client, private_key, body, event_id, *, url=WEBHOOK_URL,
          drain=True, **headers):
    """POST one signed delivery, then run the outbox relay.

    Publication is no longer synchronous with the request: the handler
    commits an outbox row and a worker publishes it. Draining here keeps
    every `publish.call_count` assertion below meaning what it always meant
    -- how many messages this delivery ultimately put on the topic -- while
    the transaction-boundary properties are asserted directly in
    `dj/apps/jobs/test_outbox.py`.

    `drain=False` is for the tests that want to look at the outbox BEFORE
    anything has published from it.
    """
    request_headers = {
        'HTTP_DYTE_SIGNATURE': _sign(private_key, body),
        'HTTP_DYTE_UUID': str(event_id),
    }
    request_headers.update(headers)
    response = client.post(
        url, data=body, content_type='application/json', **request_headers,
    )
    if drain:
        from dj.apps.jobs import outbox
        outbox.drain()
    return response


def _ppv_meeting(creator_factory):
    creator = creator_factory(tuzis=Decimal('100'))
    participant = creator_factory(tuzis=Decimal('100'))
    cm = CreatorMeeting.objects.create(
        creator=creator,
        meeting_id=str(uuid.uuid4()),
        meeting_type='ppv',
        price_per_minute=Decimal('3'),
    )
    return cm, creator, participant


def _assert_one_ppv_settlement(creator, participant):
    creator.refresh_from_db()
    participant.refresh_from_db()
    assert creator.tuzis == Decimal('106')
    assert participant.tuzis == Decimal('93')
    assert Event.objects.filter(type='PLATFORM_FEE').count() == 1
    assert Event.objects.filter(type='PAY_PER_VIEW_REVENUE').count() == 1
    assert Event.objects.filter(type='PAY_PER_VIEW_SPEND').count() == 1


@pytest.mark.django_db
@pytest.mark.parametrize(
    'identity_key', ['customParticipantId', 'clientSpecificId'],
)
def test_duplicate_ppv_delivery_moves_money_and_writes_ledger_once(
    api_client, creator_factory, keypair, identity_key,
):
    private_key, _ = keypair
    cm, creator, participant = _ppv_meeting(creator_factory)
    body = _participant_left_payload(cm, participant, identity_key)
    event_id = uuid.uuid4()

    assert _post(api_client, private_key, body, event_id).status_code == 200
    assert _post(api_client, private_key, body, event_id).status_code == 200

    _assert_one_ppv_settlement(creator, participant)
    assert WebhookDelivery.objects.filter(pk=event_id).count() == 1


@pytest.mark.django_db
def test_same_signed_payload_with_different_provider_uuids_settles_once(
    api_client, creator_factory, keypair,
):
    private_key, _ = keypair
    cm, creator, participant = _ppv_meeting(creator_factory)
    body = _participant_left_payload(cm, participant)

    assert _post(api_client, private_key, body, uuid.uuid4()).status_code == 200
    assert _post(api_client, private_key, body, uuid.uuid4()).status_code == 200

    _assert_one_ppv_settlement(creator, participant)
    assert WebhookDelivery.objects.count() == 1


@pytest.mark.django_db
def test_semantically_same_alias_and_json_order_settles_once(
    api_client, creator_factory, keypair,
):
    private_key, _ = keypair
    cm, creator, participant = _ppv_meeting(creator_factory)
    first = _participant_left_payload(cm, participant)
    legacy_data = json.loads(first)
    identity = legacy_data['participant'].pop('customParticipantId')
    legacy_data['participant']['clientSpecificId'] = identity
    reordered = json.dumps(legacy_data, sort_keys=True).encode()

    assert _post(api_client, private_key, first, uuid.uuid4()).status_code == 200
    assert _post(
        api_client, private_key, reordered, uuid.uuid4(),
    ).status_code == 200

    _assert_one_ppv_settlement(creator, participant)
    assert WebhookDelivery.objects.count() == 1


@pytest.mark.django_db
def test_general_recording_duplicate_publishes_once(
    api_client, creator_factory, keypair, webhook_boundaries,
):
    private_key, _ = keypair
    cm = CreatorMeeting.objects.create(
        creator=creator_factory(), meeting_id=str(uuid.uuid4()))
    body = _recording_payload(cm)
    event_id = uuid.uuid4()
    publish = webhook_boundaries.return_value.publish

    assert _post(api_client, private_key, body, event_id).status_code == 200
    assert _post(api_client, private_key, body, event_id).status_code == 200

    assert publish.call_count == 1
    message = publish.call_args.args[1]
    assert message['provider_event_id'] == str(event_id)
    assert message['recording_idempotency_key'] == str(
        json.loads(body)['recording']['id'])
    # The producer tags each recording-ready message with its meeting's stable
    # DB pk so the subscriber can resolve the access tier.
    assert message['meeting_pk'] == cm.pk
    # `timeout` bounds the publish RPC itself, not just the relay's wait on
    # the future -- a publisher future cannot be cancelled, so a message can
    # otherwise be accepted after the relay recorded the attempt as failed.
    assert publish.call_args.kwargs == {
        'ensure_topic': False,
        'attributes': {},
        'timeout': outbox_module.PUBLISH_TIMEOUT_SECONDS,
    }


@pytest.mark.django_db
def test_recording_ingestion_remains_available_during_money_fence(
    api_client, creator_factory, keypair, webhook_boundaries,
):
    from dj.apps.economy.models import EconomicPolicy
    EconomicPolicy.objects.filter(pk=True).update(fenced=True)
    private_key, _ = keypair
    cm = CreatorMeeting.objects.create(creator=creator_factory(), meeting_id=str(uuid.uuid4()))
    body = _recording_payload(cm)
    event_id = uuid.uuid4()
    assert _post(api_client, private_key, body, event_id).status_code == 200
    assert _post(api_client, private_key, body, event_id).status_code == 200
    assert webhook_boundaries.return_value.publish.call_count == 1


@pytest.mark.django_db
@pytest.mark.parametrize('recording_status, expected_publish_count', [
    ('UPLOADED', 1),
    ('UPLOADING', 0),
])
def test_recording_status_logs_never_expose_download_credentials(
    api_client, creator_factory, keypair, webhook_boundaries, caplog,
    recording_status, expected_publish_count,
):
    private_key, _ = keypair
    cm = CreatorMeeting.objects.create(
        creator=creator_factory(), meeting_id=str(uuid.uuid4()))
    payload = json.loads(_recording_payload(cm))
    query_secret = 'DISTINCT_QUERY_SIGNATURE_854'
    userinfo_secret = 'DISTINCT_USERINFO_PASSWORD_854'
    path_secret = 'DISTINCT_PATH_CAPABILITY_854'
    host_secret = 'distinct-host-capability-854'
    full_url = (
        f'https://recording-user:{userinfo_secret}@'
        f'{host_secret}.s3.amazonaws.com:8443/{path_secret}/recording.mp4'
        f'?X-Amz-Signature={query_secret}&X-Amz-Expires=3600'
    )
    payload['recording']['status'] = recording_status
    payload['recording']['downloadUrl'] = full_url
    body = json.dumps(payload).encode()
    publish = webhook_boundaries.return_value.publish

    with caplog.at_level(logging.DEBUG, logger='dj.apps.dyte.views'):
        response = _post(
            api_client, private_key, body, uuid.uuid4(),
        )

    assert response.status_code == 200
    assert query_secret not in caplog.text
    assert userinfo_secret not in caplog.text
    assert path_secret not in caplog.text
    assert host_secret not in caplog.text
    assert 'event=recording.statusUpdate' in caplog.text
    assert f'meeting_id={cm.meeting_id}' in caplog.text
    assert f'status={recording_status}' in caplog.text
    # Assert the security *property*, not one rendering of it. Pinning the
    # exact literal `download_url=https://amazonaws.com:8443` is not the
    # guarantee -- it is one particular rendering of it -- and the redactor is
    # allowed to become more informative in front of the allowlisted suffix,
    # because a fixed service label costs nothing and helps an operator read a
    # rejection log. That literal is what left  red on a test it never
    # touched.
    #
    # What must hold forever: the logged value carries no credential material,
    # its host still ends at the configured allowlist suffix on a DNS-label
    # boundary, and every label the redactor chose to keep is a fixed,
    # non-provider-derived token. A suffix match alone would be weaker than
    # the redactor's own threat model -- `bearer-token.notamazonaws.com:8443`
    # ends in the same characters -- so the labels are checked individually.
    logged = re.search(r'download_url=(\S+)', caplog.text)
    assert logged, caplog.text
    logged_url = logged.group(1)
    assert logged_url.startswith('https://'), logged_url
    authority = logged_url[len('https://'):]
    # No userinfo, path, query or fragment survives, so there is nowhere in the
    # rendered value for a presigned credential to hide.
    assert not re.search(r'[@/?#]', authority), logged_url
    host, _, port = authority.rpartition(':')
    assert port == '8443', logged_url
    labels = host.split('.')
    assert labels[-2:] == ['amazonaws', 'com'], logged_url
    # Anything the redactor keeps in front of the trusted suffix must be one of
    # these fixed tokens -- never a label copied from the provider's hostname,
    # which is exactly where capability URLs put bearer tokens.
    assert set(labels[:-2]) <= {'<redacted>', 's3'}, logged_url
    assert publish.call_count == expected_publish_count
    if expected_publish_count:
        # Redaction is log-only: the asynchronous consumer still needs the
        # complete presigned URL in order to download the recording.
        assert publish.call_args.args[1]['url'] == full_url


@pytest.mark.django_db
@pytest.mark.parametrize('event_type', [
    'meeting.started',
    'meeting.ended',
    'meeting.participantJoined',
    'meeting.participantLeft',
])
def test_non_recording_event_logs_never_serialize_optional_recording(
    api_client, creator_factory, keypair, caplog, event_type,
):
    """A mixed provider payload must not bypass recording URL redaction."""
    private_key, _ = keypair
    creator = creator_factory()
    cm = CreatorMeeting.objects.create(
        creator=creator, meeting_id=str(uuid.uuid4()))
    payload = json.loads(_recording_payload(cm))
    payload['event'] = event_type
    host_secret = 'distinct-cross-event-host-capability-854'
    path_secret = 'DISTINCT_CROSS_EVENT_PATH_854'
    query_secret = 'DISTINCT_CROSS_EVENT_QUERY_854'
    audio_secret = 'DISTINCT_CROSS_EVENT_AUDIO_854'
    payload['recording']['downloadUrl'] = (
        f'https://{host_secret}.s3.amazonaws.com/{path_secret}/recording.mp4'
        f'?X-Amz-Signature={query_secret}'
    )
    payload['recording']['audioDownloadUrl'] = (
        'https://audio.s3.amazonaws.com/audio.mp3'
        f'?X-Amz-Signature={audio_secret}'
    )
    if event_type.startswith('meeting.participant'):
        payload['participant'] = {
            'peerId': str(uuid.uuid4()),
            'userDisplayName': creator.username,
            'customParticipantId': creator.username,
            'joinedAt': '2026-07-21T00:00:00Z',
            'leftAt': '2026-07-21T00:01:01Z',
        }
    body = json.dumps(payload).encode()

    with caplog.at_level(logging.INFO, logger='dj.apps.dyte.views'):
        response = _post(api_client, private_key, body, uuid.uuid4())

    assert response.status_code == 200
    assert f'event={event_type}' in caplog.text
    assert f'meeting_id={cm.meeting_id}' in caplog.text
    for secret in (host_secret, path_secret, query_secret, audio_secret):
        assert secret not in caplog.text


@pytest.mark.django_db
def test_same_recording_id_with_refreshed_url_republishes_stable_key(
    api_client, creator_factory, keypair, webhook_boundaries,
):
    private_key, _ = keypair
    cm = CreatorMeeting.objects.create(
        creator=creator_factory(), meeting_id=str(uuid.uuid4()))
    first = json.loads(_recording_payload(cm))
    refreshed = {
        **first,
        'recording': {
            **first['recording'],
            'downloadUrl': (
                'https://bucket.s3.amazonaws.com/recording.mp4?signature=new'
            ),
        },
    }
    publish = webhook_boundaries.return_value.publish

    assert _post(
        api_client, private_key, json.dumps(first).encode(), uuid.uuid4(),
    ).status_code == 200
    assert _post(
        api_client, private_key, json.dumps(refreshed).encode(), uuid.uuid4(),
    ).status_code == 200

    assert publish.call_count == 2
    first_message = publish.call_args_list[0].args[1]
    refreshed_message = publish.call_args_list[1].args[1]
    assert first_message['provider_event_id'] != refreshed_message[
        'provider_event_id']
    assert first_message['recording_idempotency_key'] == refreshed_message[
        'recording_idempotency_key']
    assert first_message['recording_idempotency_key'] == first['recording']['id']


@pytest.mark.django_db
def test_expired_url_then_fresh_header_and_url_ingests_recording_once(
    api_client, creator_factory, keypair, webhook_boundaries,
    mocker, settings, tmp_path,
):
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu
    from dj.apps.dyte.models import RecordingDelivery
    from dj.apps.uploads.models import GenericFile

    private_key, _ = keypair
    cm = CreatorMeeting.objects.create(
        creator=creator_factory(), meeting_id=str(uuid.uuid4()))
    first = json.loads(_recording_payload(cm))
    first['recording']['downloadUrl'] = (
        'https://bucket.s3.amazonaws.com/recording.mp4?signature=expired'
    )
    refreshed = {
        **first,
        'recording': {
            **first['recording'],
            'downloadUrl': (
                'https://bucket.s3.amazonaws.com/recording.mp4?signature=fresh'
            ),
        },
    }

    assert _post(
        api_client, private_key, json.dumps(first).encode(), uuid.uuid4(),
    ).status_code == 200
    assert _post(
        api_client, private_key, json.dumps(refreshed).encode(), uuid.uuid4(),
    ).status_code == 200
    queued = [call.args[1] for call in (
        webhook_boundaries.return_value.publish.call_args_list
    )]
    assert len(queued) == 2
    assert queued[0]['recording_idempotency_key'] == queued[1][
        'recording_idempotency_key']

    settings.STORAGES = {
        **settings.STORAGES,
        'default': {
            'BACKEND': 'django.core.files.storage.FileSystemStorage',
        },
    }
    settings.MEDIA_ROOT = str(tmp_path)
    mocker.patch.object(dlu, 'close_old_connections')

    class _Response:
        is_redirect = False
        is_permanent_redirect = False
        headers = {}

        def __init__(self, status_code):
            self.status_code = status_code

        def raise_for_status(self):
            pass

        def iter_content(self, chunk_size=8192):
            yield b'video-bytes'

        def close(self):
            pass

    mocker.patch.object(
        dlu.requests, 'get',
        side_effect=[_Response(403), _Response(200)],
    )

    class _Message:
        def __init__(self, payload):
            self.data = json.dumps(payload).encode()
            self.acked = False
            self.nacked = False

        def ack(self):
            self.acked = True

        def nack(self):
            self.nacked = True

    expired_message = _Message(queued[0])
    refreshed_message = _Message(queued[1])
    dlu.callback(expired_message)
    dlu.callback(refreshed_message)

    recording_key = uuid.UUID(queued[0]['recording_idempotency_key'])
    assert expired_message.acked is True
    assert refreshed_message.acked is True
    assert GenericFile.objects.filter(owner=cm.creator).count() == 1
    assert RecordingDelivery.objects.get(
        pk=recording_key).completed_at is not None


@pytest.mark.django_db
def test_uploaded_without_url_does_not_suppress_later_usable_delivery(
    api_client, creator_factory, keypair, webhook_boundaries,
):
    private_key, _ = keypair
    cm = CreatorMeeting.objects.create(
        creator=creator_factory(), meeting_id=str(uuid.uuid4()))
    usable = json.loads(_recording_payload(cm))
    missing_url = {
        **usable,
        'recording': {**usable['recording'], 'downloadUrl': None},
    }
    publish = webhook_boundaries.return_value.publish

    assert _post(
        api_client, private_key, json.dumps(missing_url).encode(), uuid.uuid4(),
    ).status_code == 200
    assert WebhookDelivery.objects.count() == 0

    assert _post(
        api_client, private_key, json.dumps(usable).encode(), uuid.uuid4(),
    ).status_code == 200
    assert publish.call_count == 1
    assert WebhookDelivery.objects.count() == 1


@pytest.mark.django_db
def test_different_recording_ids_with_same_url_path_both_publish(
    api_client, creator_factory, keypair, webhook_boundaries,
):
    private_key, _ = keypair
    cm = CreatorMeeting.objects.create(
        creator=creator_factory(), meeting_id=str(uuid.uuid4()))
    first = json.loads(_recording_payload(cm))
    second = {
        **first,
        'recording': {
            **first['recording'],
            'id': str(uuid.uuid4()),
            'downloadUrl': (
                'https://bucket.s3.amazonaws.com/recording.mp4?signature=new'
            ),
        },
    }
    publish = webhook_boundaries.return_value.publish

    assert _post(
        api_client, private_key, json.dumps(first).encode(), uuid.uuid4(),
    ).status_code == 200
    assert _post(
        api_client, private_key, json.dumps(second).encode(), uuid.uuid4(),
    ).status_code == 200

    assert publish.call_count == 2
    assert WebhookDelivery.objects.count() == 2


@pytest.mark.django_db
def test_noop_event_does_not_grow_delivery_table(
    api_client, creator_factory, keypair,
):
    private_key, _ = keypair
    cm = CreatorMeeting.objects.create(
        creator=creator_factory(), meeting_id=str(uuid.uuid4()))
    body = json.dumps({
        'event': 'meeting.participantJoined',
        'meeting': _meeting(cm.meeting_id),
    }).encode()

    assert _post(
        api_client, private_key, body, uuid.uuid4(),
    ).status_code == 200
    assert WebhookDelivery.objects.count() == 0


@pytest.mark.django_db
def test_unsupported_provider_schema_is_acknowledged_without_retry(
    api_client, keypair,
):
    private_key, _ = keypair
    body = json.dumps({
        'event': 'meeting.chatSynced',
        'meetingId': str(uuid.uuid4()),
    }).encode()

    assert _post(
        api_client, private_key, body, uuid.uuid4(),
    ).status_code == 200
    assert WebhookDelivery.objects.count() == 0


@pytest.mark.django_db
def test_legacy_recording_duplicate_publishes_once(
    api_client, creator_factory, keypair, webhook_boundaries,
):
    private_key, _ = keypair
    cm = CreatorMeeting.objects.create(
        creator=creator_factory(), meeting_id=str(uuid.uuid4()))
    body = _legacy_recording_payload(cm)
    event_id = uuid.uuid4()
    publish = webhook_boundaries.return_value.publish

    assert _post(
        api_client, private_key, body, event_id, url=LEGACY_URL,
    ).status_code == 200
    assert _post(
        api_client, private_key, body, event_id, url=LEGACY_URL,
    ).status_code == 200

    assert publish.call_count == 1
    assert WebhookDelivery.objects.get().endpoint == 'recording-legacy'


@pytest.mark.django_db
def test_general_and_legacy_endpoints_share_recording_business_key(
    api_client, creator_factory, keypair, webhook_boundaries,
):
    private_key, _ = keypair
    cm = CreatorMeeting.objects.create(
        creator=creator_factory(), meeting_id=str(uuid.uuid4()))
    publish = webhook_boundaries.return_value.publish
    general = json.loads(_recording_payload(cm))
    legacy = json.loads(_legacy_recording_payload(cm))
    legacy['recording']['id'] = general['recording']['id']
    legacy['recording']['downloadUrl'] = general['recording']['downloadUrl']

    assert _post(
        api_client, private_key, json.dumps(general).encode(), uuid.uuid4(),
    ).status_code == 200
    assert _post(
        api_client, private_key, json.dumps(legacy).encode(), uuid.uuid4(),
        url=LEGACY_URL,
    ).status_code == 200

    assert publish.call_count == 1
    assert WebhookDelivery.objects.count() == 1


@pytest.mark.django_db
def test_legacy_uploading_status_does_not_consume_uploaded_business_key(
    api_client, creator_factory, keypair, webhook_boundaries,
):
    private_key, _ = keypair
    cm = CreatorMeeting.objects.create(
        creator=creator_factory(), meeting_id=str(uuid.uuid4()))
    uploaded = json.loads(_legacy_recording_payload(cm))
    uploading = {
        **uploaded,
        'recording': {**uploaded['recording'], 'status': 'UPLOADING'},
    }
    uploading_body = json.dumps(uploading).encode()
    uploaded_body = json.dumps(uploaded).encode()
    publish = webhook_boundaries.return_value.publish

    assert _post(
        api_client, private_key, uploading_body, uuid.uuid4(), url=LEGACY_URL,
    ).status_code == 200
    assert WebhookDelivery.objects.count() == 0
    assert _post(
        api_client, private_key, uploaded_body, uuid.uuid4(), url=LEGACY_URL,
    ).status_code == 200

    assert publish.call_count == 1
    assert WebhookDelivery.objects.count() == 1


@pytest.mark.django_db
def test_invalid_signature_cannot_poison_a_provider_uuid(
    api_client, creator_factory, keypair,
):
    private_key, _ = keypair
    attacker = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    cm, creator, participant = _ppv_meeting(creator_factory)
    body = _participant_left_payload(cm, participant)
    event_id = uuid.uuid4()

    rejected = _post(api_client, attacker, body, event_id)
    assert rejected.status_code == 400
    assert not WebhookDelivery.objects.filter(pk=event_id).exists()

    assert _post(api_client, private_key, body, event_id).status_code == 200
    _assert_one_ppv_settlement(creator, participant)


@pytest.mark.django_db
def test_invalid_payload_cannot_poison_a_provider_uuid(
    api_client, creator_factory, keypair,
):
    private_key, _ = keypair
    cm, creator, participant = _ppv_meeting(creator_factory)
    invalid_body = json.dumps({
        'event': 'meeting.participantLeft',
        'meeting': _meeting(cm.meeting_id),
    }).encode()
    event_id = uuid.uuid4()

    assert _post(
        api_client, private_key, invalid_body, event_id,
    ).status_code == 400
    assert _post(
        api_client, private_key, invalid_body, event_id,
    ).status_code == 400
    assert not WebhookDelivery.objects.filter(pk=event_id).exists()

    valid_body = _participant_left_payload(cm, participant)
    assert _post(
        api_client, private_key, valid_body, event_id,
    ).status_code == 200
    _assert_one_ppv_settlement(creator, participant)


@pytest.mark.django_db
def test_failed_billing_rolls_back_claim_and_retry_succeeds(
    api_client, creator_factory, keypair,
):
    private_key, _ = keypair
    cm, creator, participant = _ppv_meeting(creator_factory)
    body = _participant_left_payload(cm, participant)
    event_id = uuid.uuid4()

    with patch(
        'dj.apps.dyte.views.Event.objects.create',
        side_effect=RuntimeError('ledger unavailable'),
    ), pytest.raises(RuntimeError, match='ledger unavailable'):
        _post(api_client, private_key, body, event_id)

    assert not WebhookDelivery.objects.filter(pk=event_id).exists()
    creator.refresh_from_db()
    participant.refresh_from_db()
    assert creator.tuzis == Decimal('100')
    assert participant.tuzis == Decimal('100')
    assert Event.objects.count() == 0

    assert _post(api_client, private_key, body, event_id).status_code == 200
    _assert_one_ppv_settlement(creator, participant)


# --------------------------------------------------------------------------
# Pub/Sub failure. THE CONTRACT CHANGED IN  -- read this before "fixing"
# these two.
#
# Before: the publish ran inside the webhook's transaction and a failure
# propagated, rolling the delivery claim back so the provider's retry could
# publish again. That made the provider our retry mechanism, and it only
# works while the provider is still retrying: a crash between COMMIT and the
# publish committed the claim with no message and no retry at all, and the
# recording was lost for good (the download URL expires).
#
# Now: the claim and the outbox row commit together, the request returns 200
# (nothing is left for the provider to redo), and the RELAY owns the retry
# with its own durable backoff.
# --------------------------------------------------------------------------

@pytest.mark.django_db
def test_synchronous_pubsub_failure_keeps_the_claim_and_retries_durably(
    api_client, creator_factory, keypair, webhook_boundaries,
):
    from dj.apps.jobs import outbox
    from dj.apps.jobs.models import OutboxMessage

    private_key, _ = keypair
    cm = CreatorMeeting.objects.create(
        creator=creator_factory(), meeting_id=str(uuid.uuid4()))
    body = _recording_payload(cm)
    event_id = uuid.uuid4()
    publish = webhook_boundaries.return_value.publish
    publish.side_effect = RuntimeError('publisher unavailable')

    assert _post(api_client, private_key, body, event_id).status_code == 200
    # The webhook succeeded even though Pub/Sub did not, because the promise
    # to publish is committed and durable.
    assert WebhookDelivery.objects.filter(pk=event_id).exists()
    row = OutboxMessage.objects.get()
    assert row.published_at is None
    assert row.attempts == 1
    assert 'publisher unavailable' in row.last_error

    # A provider redelivery is now a genuine no-op -- it must NOT create a
    # second message just because the first has not gone out yet.
    assert _post(api_client, private_key, body, event_id).status_code == 200
    assert OutboxMessage.objects.count() == 1

    # The relay is what recovers it, on its own schedule.
    publish.side_effect = None
    later = timezone.now() + timezone.timedelta(
        seconds=outbox.backoff_seconds(1) + 1)
    assert outbox.drain(now=later)['published'] == 1
    row.refresh_from_db()
    assert row.published_at is not None
    assert publish.call_args.args[1]['provider_event_id'] == str(event_id)


@pytest.mark.django_db
def test_asynchronous_pubsub_failure_keeps_the_claim_and_retries_durably(
    api_client, creator_factory, keypair, webhook_boundaries,
):
    """A rejected future is a failure. Anything else silently loses messages."""
    from dj.apps.jobs import outbox
    from dj.apps.jobs.models import OutboxMessage

    private_key, _ = keypair
    cm = CreatorMeeting.objects.create(
        creator=creator_factory(), meeting_id=str(uuid.uuid4()))
    body = _recording_payload(cm)
    event_id = uuid.uuid4()
    failed = Future()
    failed.set_exception(RuntimeError('publish was rejected'))
    succeeded = Future()
    succeeded.set_result('message-id')
    publish = webhook_boundaries.return_value.publish
    publish.side_effect = [failed, succeeded]

    assert _post(api_client, private_key, body, event_id).status_code == 200
    assert WebhookDelivery.objects.filter(pk=event_id).exists()
    row = OutboxMessage.objects.get()
    assert row.published_at is None
    assert 'publish was rejected' in row.last_error

    later = timezone.now() + timezone.timedelta(
        seconds=outbox.backoff_seconds(1) + 1)
    assert outbox.drain(now=later)['published'] == 1
    row.refresh_from_db()
    assert row.published_at is not None
    assert publish.call_count == 2


@pytest.mark.django_db
def test_the_webhook_never_waits_on_pubsub(
    api_client, creator_factory, keypair, webhook_boundaries, mocker,
):
    """The  defect, pinned: no Pub/Sub call on the request path at all.

    A slow publisher used to hold a web worker's database connection for up
    to DYTE_PUBSUB_PUBLISH_TIMEOUT_SECONDS inside an open transaction. The
    guarantee now is stronger than "it is fast": the request does not talk to
    Pub/Sub, so there is nothing to be slow.

    THIS ASSERTS ON CONSTRUCTION, NOT ON A COUNTER. It used to read
    ``assert webhook_boundaries.call_count == 0``, which could not fail: that
    fixture patches ``dj.apps.jobs.outbox.PubSubClient``, and with
    ``drain=False`` nothing in the relay runs, so the counter was zero
    whatever the view did. The property is about ``dyte.views``, so it is
    pinned two ways that can actually go red:

    1. every name a Pub/Sub client is reachable through -- the source class,
       the three modules that bind it at import time, and the underlying
       ``pubsub_v1`` transports -- raises if it is constructed at all; and
    2. ``dyte.views`` must not hold a client as a module attribute, which is
       the exact shape the pre- code had (``publish_recording_ready``
       imported ``PubSubClient`` at module level, so patching the source
       module would not have caught it).
    """
    from dj.apps.dyte import views as dyte_views
    from dj.apps.jobs.models import OutboxMessage

    def _explode(*args, **kwargs):
        raise AssertionError(
            'the request path constructed a Pub/Sub client -- #788 says the '
            'webhook writes an outbox row and a worker publishes it')

    for target in (
        'gcp.pubsub.client.PubSubClient',
        'dj.apps.jobs.outbox.PubSubClient',
        'dj.apps.events.signals.PubSubClient',
        'dj.apps.g12f.publication.PubSubClient',
        'gcp.pubsub.client.pubsub_v1.PublisherClient',
        'gcp.pubsub.client.pubsub_v1.SubscriberClient',
    ):
        mocker.patch(target, side_effect=_explode)

    assert not hasattr(dyte_views, 'PubSubClient'), (
        'dyte.views must not import a Pub/Sub client: a module-level binding '
        'is invisible to every patch above, which is how #788 got in')

    private_key, _ = keypair
    cm = CreatorMeeting.objects.create(
        creator=creator_factory(), meeting_id=str(uuid.uuid4()))
    publish = webhook_boundaries.return_value.publish

    response = _post(
        api_client, private_key, _recording_payload(cm), uuid.uuid4(),
        drain=False,
    )

    assert response.status_code == 200
    publish.assert_not_called()
    assert OutboxMessage.objects.filter(published_at__isnull=True).count() == 1


@pytest.mark.django_db
def test_rtk_uuid_is_preferred_over_legacy_uuid(
    api_client, creator_factory, keypair,
):
    private_key, _ = keypair
    cm = CreatorMeeting.objects.create(
        creator=creator_factory(), meeting_id=str(uuid.uuid4()))
    body = _recording_payload(cm)
    legacy_id = uuid.uuid4()
    rtk_id = uuid.uuid4()

    response = _post(
        api_client,
        private_key,
        body,
        legacy_id,
        HTTP_RTK_UUID=str(rtk_id),
    )

    assert response.status_code == 200
    assert WebhookDelivery.objects.filter(pk=rtk_id).exists()
    assert not WebhookDelivery.objects.filter(pk=legacy_id).exists()


@pytest.mark.django_db
@pytest.mark.parametrize('event_id', [None, 'not-a-uuid'])
def test_signed_delivery_without_usable_uuid_is_rejected_before_effects(
    api_client, creator_factory, keypair, event_id,
):
    private_key, _ = keypair
    cm, creator, participant = _ppv_meeting(creator_factory)
    body = _participant_left_payload(cm, participant)
    headers = {'HTTP_DYTE_SIGNATURE': _sign(private_key, body)}
    if event_id is not None:
        headers['HTTP_DYTE_UUID'] = event_id

    response = api_client.post(
        WEBHOOK_URL, data=body, content_type='application/json', **headers,
    )

    assert response.status_code == 400
    creator.refresh_from_db()
    participant.refresh_from_db()
    assert creator.tuzis == Decimal('100')
    assert participant.tuzis == Decimal('100')
    assert Event.objects.count() == 0
    assert WebhookDelivery.objects.count() == 0


@pytest.mark.django_db(transaction=True)
def test_concurrent_duplicate_ppv_deliveries_settle_once(
    creator_factory, keypair, mocker,
):
    private_key, _ = keypair
    cm, creator, participant = _ppv_meeting(creator_factory)
    body = _participant_left_payload(cm, participant)
    event_id = uuid.uuid4()
    barrier = threading.Barrier(2)

    from dj.apps.dyte import views as dyte_views
    original_claim = dyte_views.claim_webhook_delivery

    def simultaneous_claim(**kwargs):
        barrier.wait(timeout=10)
        return original_claim(**kwargs)

    mocker.patch(
        'dj.apps.dyte.views.claim_webhook_delivery',
        side_effect=simultaneous_claim,
    )

    def deliver():
        close_old_connections()
        try:
            return _post(
                APIClient(), private_key, body, event_id,
            ).status_code
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(pool.map(lambda _unused: deliver(), range(2)))

    assert statuses == [200, 200]
    _assert_one_ppv_settlement(creator, participant)
    assert WebhookDelivery.objects.filter(pk=event_id).count() == 1
