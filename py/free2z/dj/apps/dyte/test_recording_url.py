"""SSRF allowlist for recording download URLs.

Unit tests for `is_allowed_recording_url` against the prod-shaped default
allowlist, plus an end-to-end test that the `dyte_download_upload` sink refuses
a non-allowlisted URL before making any outbound request.
"""
import ast
import json
import logging
import uuid
from pathlib import Path

import pytest

from dj.apps.dyte.recording import (
    is_allowed_recording_url,
    redact_recording_url,
)

# The production default (mirrors settings._DYTE_RECORDING_ALLOWED_HOSTS_DEFAULT).
PROD_HOSTS = [
    "amazonaws.com",
    "cloudflarestorage.com",
    "realtime.cloudflare.com",
    "dyte.io",
    "dyte.in",
]



@pytest.mark.parametrize("url", [
    # S3 presigned — the actual live storage backend.
    "https://my-bucket.s3.us-east-1.amazonaws.com/rec.mp4?X-Amz-Signature=abc",
    "https://dyte-recordings.s3.amazonaws.com/x.mp4",
    # Cloudflare R2 (post-migration path).
    "https://acct.r2.cloudflarestorage.com/rec.mp4",
    # Provider origins.
    "https://api.realtime.cloudflare.com/v2/recordings/x.mp4",
    "https://storage.dyte.io/x.mp4",
    "https://cdn.dyte.in/x.mp4",
])
def test_allows_real_provider_hosts(url):
    assert is_allowed_recording_url(url, PROD_HOSTS) is True


@pytest.mark.parametrize("url", [
    # The exact repro from.
    "http://attacker.example/x.mp4",
    "https://attacker.example/x.mp4",
    # http even on an allowed host — https is required.
    "http://bucket.s3.amazonaws.com/x.mp4",
    # Classic SSRF targets.
    "http://169.254.169.254/latest/meta-data/",
    "https://169.254.169.254/latest/meta-data/",
    "http://localhost/x",
    "https://metadata.google.internal/computeMetadata/v1/",
    "http://10.0.0.5/x",
    "file:///etc/passwd",
    "gopher://internal:70/x",
    # Suffix-confusion: the allowed token appears but is not the real suffix.
    "https://amazonaws.com.evil.example/x.mp4",
    "https://notamazonaws.com/x.mp4",
    "https://evil.example/amazonaws.com/x.mp4",
    # userinfo trick: the real host is evil.example, not the S3 label.
    "https://bucket.s3.amazonaws.com@evil.example/x.mp4",
    # Junk.
    "",
    "not a url",
    None,
])
def test_refuses_everything_else(url):
    assert is_allowed_recording_url(url, PROD_HOSTS) is False


def test_empty_allowlist_refuses_everything():
    assert is_allowed_recording_url(
        "https://bucket.s3.amazonaws.com/x.mp4", []) is False


def test_leading_dot_and_whitespace_in_suffix_are_tolerated():
    assert is_allowed_recording_url(
        "https://bucket.s3.amazonaws.com/x.mp4", ["  .amazonaws.com "]) is True


@pytest.mark.parametrize("url, allowed_hosts, expected", [
    (
        "https://user:password@BEARER-CAPABILITY.s3.amazonaws.com:8443/rec.mp4"
        "?X-Amz-Signature=secret#private-fragment",
        PROD_HOSTS,
        "https://<redacted>.s3.amazonaws.com:8443",
    ),
    (
        "https://user:password@[2001:db8::1]:443/rec.mp4?signature=secret",
        ["2001:db8::1"],
        "https://[2001:db8::1]:443",
    ),
    (
        "https://[2001:db8::1]:443/rec.mp4?signature=secret",
        PROD_HOSTS,
        "https://[2001:db8::1]:443",
    ),
    (
        "https://amazonaws.com.evil.example/secret",
        PROD_HOSTS,
        "https://<redacted>.evil.example",
    ),
    (
        "https://DISTINCT-UNKNOWN-BEARER.example/secret",
        PROD_HOSTS,
        "https://<redacted>.example",
    ),
    ("not a url", PROD_HOSTS, "<invalid recording url>"),
    (None, PROD_HOSTS, "<invalid recording url>"),
    (
        "https://user:password@example.com:99999/rec.mp4?signature=secret",
        PROD_HOSTS,
        "<unparseable recording url>",
    ),
])
def test_redact_recording_url_removes_credentials_safely(
    url, allowed_hosts, expected,
):
    assert redact_recording_url(url, allowed_hosts) == expected


def test_redact_recording_url_uses_most_specific_allowed_suffix():
    assert redact_recording_url(
        "https://BEARER-CAPABILITY.s3.amazonaws.com/recording.mp4",
        ["amazonaws.com", "s3.amazonaws.com"],
    ) == "https://<redacted>.s3.amazonaws.com"


@pytest.mark.parametrize("url,expected", [
    # A two-label host is the one place a capability could survive into the
    # log, because there is no subdomain to mark. The keyword list only catches
    # a label that names itself, so length is the backstop: a capability needs
    # enough entropy to be unguessable and a readable registrable name does
    # not. Both of these are >24 characters and neither says "token".
    (
        "https://ZmFrZWNhcGFiaWxpdHl0b2tlbnZhbHVl.example/rec.mp4",
        "https://<redacted>.example",
    ),
    (
        "https://opaque-live-download-keyx.io/rec.mp4",
        "https://<redacted>.io",
    ),
    # `s3-<anything>` satisfies the region shape on the allowlisted path, so
    # the same bound has to apply there or it is a hole by another name.
    (
        "https://s3-ZmFrZWNhcGFiaWxpdHl0b2tlbg.amazonaws.com/rec.mp4",
        "https://<redacted>.amazonaws.com",
    ),
    #...without costing the operator the context the redactor exists to keep.
    ("https://s3-us-east-1.amazonaws.com/rec.mp4",
     "https://s3-us-east-1.amazonaws.com"),
    ("https://short.example/rec.mp4", "https://short.example"),
])
def test_redact_recording_url_bounds_capability_shaped_labels(url, expected):
    assert redact_recording_url(url, PROD_HOSTS) == expected


# --------------------------------------------------------------------------
# Settings wiring
# --------------------------------------------------------------------------


def test_default_allowlist_is_populated_and_includes_s3(settings):
    # Recordings use AWS storage, so this MUST be present or the pipeline
    # breaks with the default config.
    assert "amazonaws.com" in settings.DYTE_RECORDING_ALLOWED_HOSTS


# --------------------------------------------------------------------------
# The sink refuses a non-allowlisted URL without any outbound request
# --------------------------------------------------------------------------


class _Message:
    def __init__(self, payload):
        self.data = (
            payload if isinstance(payload, bytes)
            else json.dumps(payload).encode("utf-8")
        )
        self.acked = False
        self.nacked = False

    def ack(self):
        self.acked = True

    def nack(self):
        self.nacked = True

@pytest.fixture(autouse=True)
def _no_close_connections(mocker):
    # The subscriber's catch_errors wrapper calls close_old_connections() on
    # every message; under a test transaction that would drop the DB
    # connection. It is pure infra plumbing, irrelevant to these assertions.
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu
    mocker.patch.object(dlu, "close_old_connections")


@pytest.mark.django_db
def test_sink_refuses_non_allowlisted_url_without_fetching(
    creator_factory, mocker
):
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu

    creator = creator_factory()
    get = mocker.patch.object(dlu.requests, "get")

    msg = _Message({
        "username": creator.username,
        "url": "http://attacker.example/x.mp4",
    })
    dlu.callback(msg)

    # No outbound request, message acked (so it is not redelivered forever),
    # and nothing stored.
    get.assert_not_called()
    assert msg.acked is True
    from dj.apps.uploads.models import GenericFile
    assert not GenericFile.objects.filter(owner=creator).exists()


@pytest.fixture
def _local_media(settings, tmp_path):
    # Store to a tmp dir, never GCS, when a test actually saves a file.
    settings.STORAGES = {
        **settings.STORAGES,
        "default": {
            "BACKEND": "django.core.files.storage.FileSystemStorage",
        },
    }
    settings.MEDIA_ROOT = str(tmp_path)


@pytest.mark.django_db
def test_sink_downloads_an_allowlisted_url(
    creator_factory, mocker, settings, _local_media
):
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu

    creator = creator_factory()

    class _Resp:
        is_redirect = False
        is_permanent_redirect = False
        headers = {}

        def raise_for_status(self):
            pass

        def iter_content(self, chunk_size=8192):
            yield b"video-bytes"

        def close(self):
            pass

    get = mocker.patch.object(dlu.requests, "get", return_value=_Resp())

    msg = _Message({
        "username": creator.username,
        "url": "https://bucket.s3.us-east-1.amazonaws.com/rec.mp4",
    })
    dlu.callback(msg)

    get.assert_called_once()
    # The download call is bounded and does not follow redirects.
    assert get.call_args.kwargs["allow_redirects"] is False
    assert get.call_args.kwargs["timeout"] == (
        settings.DYTE_RECORDING_DOWNLOAD_TIMEOUT_SECONDS)
    assert msg.acked is True
    from dj.apps.uploads.models import GenericFile
    assert GenericFile.objects.filter(owner=creator).exists()


@pytest.mark.django_db
def test_sink_accepts_recording_url_without_extension_or_content_type(
    creator_factory, mocker, settings, _local_media,
):
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu
    from dj.apps.dyte.models import BROADCAST, CreatorMeeting
    from dj.apps.uploads.models import GenericFile

    creator = creator_factory()
    meeting = CreatorMeeting.objects.create(
        creator=creator, meeting_type=BROADCAST)

    class _Resp:
        is_redirect = False
        is_permanent_redirect = False
        status_code = 200
        headers = {}

        def raise_for_status(self):
            pass

        def iter_content(self, chunk_size=8192):
            yield b'video-bytes'

        def close(self):
            pass

    mocker.patch.object(dlu.requests, 'get', return_value=_Resp())
    message = _Message({
        'username': creator.username,
        'url': 'https://bucket.s3.amazonaws.com/presigned-recording',
        'provider_event_id': str(uuid.uuid4()),
        'meeting_pk': meeting.pk,
    })

    dlu.callback(message)

    assert message.acked is True
    assert message.nacked is False
    stored = GenericFile.objects.get(owner=creator)
    assert stored.access == 'public'
    assert stored.mime_type == 'video/mp4'
    assert stored.file.name.startswith('recordings/')
    # The object name is extensionless, and its UUID is generated by the sink,
    # not copied from the provider URL.
    recording_name = stored.file.name.removeprefix('recordings/')
    assert str(uuid.UUID(recording_name)) == recording_name


@pytest.mark.django_db
def test_sink_deduplicates_provider_event_uuid(
    creator_factory, mocker, settings, _local_media
):
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu
    from dj.apps.dyte.models import RecordingDelivery
    from dj.apps.uploads.models import GenericFile

    creator = creator_factory()

    class _Resp:
        is_redirect = False
        is_permanent_redirect = False
        headers = {}

        def raise_for_status(self):
            pass

        def iter_content(self, chunk_size=8192):
            yield b"video-bytes"

        def close(self):
            pass

    get = mocker.patch.object(dlu.requests, "get", return_value=_Resp())
    event_id = uuid.uuid4()
    payload = {
        "username": creator.username,
        "url": "https://bucket.s3.amazonaws.com/recording.mp4",
        "provider_event_id": str(event_id),
    }
    first = _Message(payload)
    duplicate = _Message(payload)

    dlu.callback(first)
    dlu.callback(duplicate)

    assert first.acked is True
    assert duplicate.acked is True
    assert get.call_count == 1
    assert GenericFile.objects.filter(owner=creator).count() == 1
    delivery = RecordingDelivery.objects.get(pk=event_id)
    assert delivery.completed_at is not None
    assert delivery.lease_token is None
    assert delivery.lease_expires_at is None


@pytest.mark.django_db
def test_sink_deduplicates_recording_key_across_fresh_webhook_uuids(
    creator_factory, mocker, _local_media,
):
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu
    from dj.apps.dyte.models import RecordingDelivery
    from dj.apps.uploads.models import GenericFile

    creator = creator_factory()

    class _Resp:
        is_redirect = False
        is_permanent_redirect = False
        status_code = 200
        headers = {}

        def raise_for_status(self):
            pass

        def iter_content(self, chunk_size=8192):
            yield b'video-bytes'

        def close(self):
            pass

    get = mocker.patch.object(dlu.requests, 'get', return_value=_Resp())
    recording_key = uuid.uuid4()
    common = {
        'username': creator.username,
        'url': 'https://bucket.s3.amazonaws.com/recording.mp4',
        'recording_idempotency_key': str(recording_key),
    }

    dlu.callback(_Message({
        **common, 'provider_event_id': str(uuid.uuid4()),
    }))
    duplicate = _Message({
        **common, 'provider_event_id': str(uuid.uuid4()),
    })
    dlu.callback(duplicate)

    assert duplicate.acked is True
    assert get.call_count == 1
    assert GenericFile.objects.filter(owner=creator).count() == 1
    assert RecordingDelivery.objects.filter(pk=recording_key).count() == 1


@pytest.mark.django_db
def test_pre_idempotency_queue_message_gets_stable_transition_receipt(
    creator_factory, mocker, _local_media,
):
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu
    from dj.apps.dyte.models import RecordingDelivery

    creator = creator_factory()

    class _Resp:
        is_redirect = False
        is_permanent_redirect = False
        status_code = 200
        headers = {}

        def raise_for_status(self):
            pass

        def iter_content(self, chunk_size=8192):
            yield b'video-bytes'

        def close(self):
            pass

    get = mocker.patch.object(dlu.requests, 'get', return_value=_Resp())
    payload = {
        'username': creator.username,
        'url': 'https://bucket.s3.amazonaws.com/queued.mp4?old=signature',
    }

    dlu.callback(_Message(payload))
    dlu.callback(_Message({
        **payload,
        'url': 'https://bucket.s3.amazonaws.com/queued.mp4?new=signature',
    }))

    assert get.call_count == 1
    assert RecordingDelivery.objects.count() == 1


@pytest.mark.django_db
def test_pre_change_queue_message_and_new_semantic_key_share_receipt(
    creator_factory, mocker, _local_media,
):
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu
    from dj.apps.dyte.models import RecordingDelivery
    from dj.apps.uploads.models import GenericFile

    creator = creator_factory()

    class _Resp:
        is_redirect = False
        is_permanent_redirect = False
        status_code = 200
        headers = {}

        def raise_for_status(self):
            pass

        def iter_content(self, chunk_size=8192):
            yield b'video-bytes'

        def close(self):
            pass

    get = mocker.patch.object(dlu.requests, 'get', return_value=_Resp())
    url = 'https://bucket.s3.amazonaws.com/queued.mp4?old=signature'
    dlu.callback(_Message({
        'username': creator.username,
        'url': url,
    }))
    new_message = _Message({
        'username': creator.username,
        'url': 'https://bucket.s3.amazonaws.com/queued.mp4?new=signature',
        'provider_event_id': str(uuid.uuid4()),
        'recording_idempotency_key': str(uuid.uuid4()),
    })

    dlu.callback(new_message)

    assert new_message.acked is True
    assert get.call_count == 1
    assert GenericFile.objects.filter(owner=creator).count() == 1
    receipt = RecordingDelivery.objects.get()
    assert receipt.legacy_fallback is True
    assert receipt.source_url_key == dlu.recording_source_url_key(
        creator.username, url)


@pytest.mark.django_db
def test_current_recording_uuids_sharing_path_remain_distinct(
    creator_factory, mocker, _local_media,
):
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu
    from dj.apps.dyte.models import RecordingDelivery
    from dj.apps.uploads.models import GenericFile

    creator = creator_factory()

    class _Resp:
        is_redirect = False
        is_permanent_redirect = False
        status_code = 200
        headers = {}

        def raise_for_status(self):
            pass

        def iter_content(self, chunk_size=8192):
            yield b'video-bytes'

        def close(self):
            pass

    get = mocker.patch.object(dlu.requests, 'get', return_value=_Resp())
    common = {
        'username': creator.username,
        'url': 'https://bucket.s3.amazonaws.com/reused.mp4',
    }

    for _ in range(2):
        dlu.callback(_Message({
            **common,
            'provider_event_id': str(uuid.uuid4()),
            'recording_idempotency_key': str(uuid.uuid4()),
        }))

    assert get.call_count == 2
    assert GenericFile.objects.filter(owner=creator).count() == 2
    assert RecordingDelivery.objects.count() == 2
    assert not RecordingDelivery.objects.filter(legacy_fallback=True).exists()


@pytest.mark.django_db
def test_expired_transition_alias_does_not_suppress_future_recording(
    creator_factory, mocker, settings, _local_media,
):
    from datetime import timedelta
    from django.utils import timezone
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu
    from dj.apps.dyte.models import RecordingDelivery
    from dj.apps.uploads.models import GenericFile

    creator = creator_factory()

    class _Resp:
        is_redirect = False
        is_permanent_redirect = False
        status_code = 200
        headers = {}

        def raise_for_status(self):
            pass

        def iter_content(self, chunk_size=8192):
            yield b'video-bytes'

        def close(self):
            pass

    get = mocker.patch.object(dlu.requests, 'get', return_value=_Resp())
    common = {
        'username': creator.username,
        'url': 'https://bucket.s3.amazonaws.com/reused-later.mp4',
    }
    dlu.callback(_Message(common))
    RecordingDelivery.objects.update(
        processed_at=(
            timezone.now()
            - timedelta(
                seconds=settings.DYTE_RECORDING_TRANSITION_ALIAS_SECONDS + 1)
        ),
    )

    dlu.callback(_Message({
        **common,
        'provider_event_id': str(uuid.uuid4()),
        'recording_idempotency_key': str(uuid.uuid4()),
    }))

    assert get.call_count == 2
    assert GenericFile.objects.filter(owner=creator).count() == 2
    assert RecordingDelivery.objects.count() == 2


@pytest.mark.django_db
def test_long_username_cannot_poison_recording_title(
    creator_factory, mocker, _local_media,
):
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu
    from dj.apps.uploads.models import GenericFile

    creator = creator_factory(username='u' * 150)

    class _Resp:
        is_redirect = False
        is_permanent_redirect = False
        status_code = 200
        headers = {}

        def raise_for_status(self):
            pass

        def iter_content(self, chunk_size=8192):
            yield b'video-bytes'

        def close(self):
            pass

    mocker.patch.object(dlu.requests, 'get', return_value=_Resp())
    message = _Message({
        'username': creator.username,
        'url': 'https://bucket.s3.amazonaws.com/recording.mp4',
        'provider_event_id': str(uuid.uuid4()),
    })

    dlu.callback(message)

    assert message.acked is True
    assert len(GenericFile.objects.get(owner=creator).title) == 128


@pytest.mark.django_db
def test_concurrent_recording_claim_is_retried_without_waiting():
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu

    event_id = uuid.uuid4()
    assert dlu.claim_recording(event_id)[0] == 'claimed'
    duplicate = _Message({
        'username': 'alice',
        'url': 'https://bucket.s3.amazonaws.com/recording.mp4',
        'provider_event_id': str(event_id),
    })

    dlu.callback(duplicate)

    assert duplicate.acked is False
    assert duplicate.nacked is True


@pytest.mark.django_db
def test_expired_lease_is_taken_over_without_old_owner_stealing_it():
    from datetime import timedelta
    from django.utils import timezone
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu
    from dj.apps.dyte.models import RecordingDelivery

    event_id = uuid.uuid4()
    first_status, first_token = dlu.claim_recording(event_id)
    assert first_status == 'claimed'
    RecordingDelivery.objects.filter(pk=event_id).update(
        lease_expires_at=timezone.now() - timedelta(seconds=1))

    second_status, second_token = dlu.claim_recording(event_id)

    assert second_status == 'claimed'
    assert second_token != first_token
    dlu.release_recording_claim(event_id, first_token)
    dlu.discard_recording_claim(event_id, first_token)
    delivery = RecordingDelivery.objects.get(pk=event_id)
    assert delivery.lease_token == second_token
    assert delivery.lease_expires_at > timezone.now()


@pytest.mark.django_db
def test_database_failure_nacks_recording_for_retry(mocker):
    from django.db import OperationalError
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu

    message = _Message({
        'username': 'alice',
        'url': 'https://bucket.s3.amazonaws.com/recording.mp4',
        'provider_event_id': str(uuid.uuid4()),
    })
    mocker.patch.object(
        dlu.RecordingDelivery.objects,
        'select_for_update',
        side_effect=OperationalError('cloud sql restarting'),
    )

    dlu.callback(message)

    assert message.nacked is True
    assert message.acked is False
    assert not dlu.RecordingDelivery.objects.exists()


def test_catch_errors_logs_sanitized_traceback(caplog):
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu

    secret = 'presigned-callback-secret'
    url = (
        f'https://BEARER-{secret}.s3.amazonaws.com/{secret}.mp4'
        f'?X-Amz-Signature={secret}'
    )
    provider_event_id = str(uuid.uuid4())
    message = _Message({
        'username': 'alice',
        'url': url,
        'provider_event_id': provider_event_id,
    })

    @dlu.catch_errors
    def fail_callback(_message):
        raise RuntimeError(f'GET {url} failed in recording callback')

    with caplog.at_level(logging.ERROR):
        fail_callback(message)

    assert message.nacked is True
    assert message.acked is False
    assert 'Traceback (most recent call last)' in caplog.text
    assert 'fail_callback' in caplog.text
    assert 'RuntimeError' in caplog.text
    assert 'https://<redacted>.s3.amazonaws.com' in caplog.text
    assert secret not in caplog.text
    # A traceback alone cannot tell an operator WHICH recording is NACK-looping
    # in the subscriber's single flow-control slot.
    assert f'provider_event={provider_event_id}' in caplog.text
    assert 'creator=alice' in caplog.text


@pytest.mark.parametrize('payload,expected', [
    # A payload that is not even JSON still has to name itself as such.
    (b'not json at all', 'recording=<unparseable payload>'),
    ({'meeting': 'x'}, 'recording=<no identifiers in payload>'),
    # Untrusted values are fingerprinted, never echoed, so a hostile payload
    # cannot forge log lines or smuggle a credential into the diagnostic.
    ({'username': 'a\nERROR forged line'}, 'creator=<invalid-string:'),
    ({'recording_idempotency_key': 42}, 'recording=<invalid-int>'),
    ({'username': None}, 'creator=<missing>'),
])
def test_callback_identity_context_never_echoes_untrusted_payload(
    payload, expected,
):
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu

    class _Raw:
        data = payload if isinstance(payload, bytes) else json.dumps(
            payload).encode()

    identity = dlu._message_recording_identity(_Raw())
    assert expected in identity
    assert '\n' not in identity


@pytest.mark.django_db
@pytest.mark.parametrize('status_code', [403, 404])
def test_transient_download_status_exhaustion_is_alerted_and_acked(
    mocker, creator_factory, caplog, status_code,
):
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu

    creator = creator_factory()
    response = mocker.Mock(
        is_redirect=False,
        is_permanent_redirect=False,
        status_code=status_code,
        headers={},
    )
    get = mocker.patch.object(dlu.requests, 'get', return_value=response)
    sleep = mocker.patch.object(dlu.time, 'sleep')
    enqueue = mocker.patch.object(dlu, 'enqueue_recording_recovery')
    event_id = uuid.uuid4()
    message = _Message({
        'username': creator.username,
        'url': 'https://bucket.s3.amazonaws.com/expired.mp4',
        'provider_event_id': str(event_id),
    })

    with caplog.at_level(logging.WARNING):
        dlu.callback(message)

    assert message.acked is True
    assert message.nacked is False
    assert get.call_count == dlu.RECORDING_DOWNLOAD_MAX_ATTEMPTS
    assert sleep.call_args_list == [
        mocker.call(1.0), mocker.call(2.0),
    ]
    assert response.close.call_count == dlu.RECORDING_DOWNLOAD_MAX_ATTEMPTS
    enqueue.assert_called_once()
    assert 'durable recovery scheduled' in caplog.text
    assert 'RECORDING DOWNLOAD RETRY EXHAUSTED' not in caplog.text
    assert f'HTTP {status_code}' in caplog.text
    delivery = dlu.RecordingDelivery.objects.get(pk=event_id)
    assert delivery.completed_at is None
    assert delivery.lease_expires_at <= dlu.timezone.now()
    assert delivery.download_url == 'https://bucket.s3.amazonaws.com/expired.mp4'
    assert delivery.retry_count == 1
    assert delivery.next_retry_at is not None
    assert delivery.retry_exhausted_at is None


@pytest.mark.django_db
def test_durable_recovery_ingests_without_a_refreshed_provider_callback(
    mocker, creator_factory, _local_media,
):
    """The ACKed Pub/Sub delivery is recoverable from its receipt alone."""
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu
    from dj.apps.dyte.models import RecordingDelivery
    from dj.apps.dyte.tasks import retry_recording_delivery
    from dj.apps.uploads.models import GenericFile

    creator = creator_factory()

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

    recording_key = uuid.uuid4()
    get = mocker.patch.object(
        dlu.requests, 'get',
        side_effect=[_Response(403), _Response(403), _Response(403),
                      _Response(200)],
    )
    mocker.patch.object(dlu.time, 'sleep')
    mocker.patch.object(dlu, 'enqueue_recording_recovery')
    message = _Message({
        'username': creator.username,
        'recording_idempotency_key': str(recording_key),
        'url': 'https://bucket.s3.amazonaws.com/recording.mp4?signature=one',
        'provider_event_id': str(uuid.uuid4()),
    })

    dlu.callback(message)
    assert message.acked is True
    receipt = RecordingDelivery.objects.get(pk=recording_key)
    receipt.next_retry_at = dlu.timezone.now()
    receipt.save(update_fields=['next_retry_at'])

    retry_recording_delivery(str(recording_key))

    assert get.call_count == dlu.RECORDING_DOWNLOAD_MAX_ATTEMPTS + 1
    assert GenericFile.objects.filter(owner=creator).count() == 1
    receipt.refresh_from_db()
    assert receipt.completed_at is not None
    assert receipt.download_url == ''
    assert receipt.retry_exhausted_at is None


@pytest.mark.django_db
def test_durable_recording_recovery_is_bounded_and_alerted(
    mocker, creator_factory, caplog, settings,
):
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu

    creator = creator_factory()
    settings.DYTE_RECORDING_RECOVERY_MAX_ATTEMPTS = 1
    response = mocker.Mock(
        is_redirect=False,
        is_permanent_redirect=False,
        status_code=403,
        headers={},
    )
    mocker.patch.object(dlu.requests, 'get', return_value=response)
    mocker.patch.object(dlu.time, 'sleep')
    enqueue = mocker.patch.object(dlu, 'enqueue_recording_recovery')
    event_id = uuid.uuid4()
    message = _Message({
        'username': creator.username,
        'url': 'https://bucket.s3.amazonaws.com/expired.mp4',
        'provider_event_id': str(event_id),
    })

    with caplog.at_level(logging.ERROR):
        dlu.callback(message)

    assert message.acked is True
    assert message.nacked is False
    enqueue.assert_not_called()
    assert 'RECORDING DOWNLOAD RETRY EXHAUSTED' in caplog.text
    delivery = dlu.RecordingDelivery.objects.get(pk=event_id)
    assert delivery.completed_at is None
    assert delivery.retry_exhausted_at is not None
    assert delivery.download_url == ''


@pytest.mark.django_db
def test_recording_recovery_sweep_alerts_on_stuck_receipt(
    creator_factory, caplog, settings,
):
    from datetime import timedelta
    from django.utils import timezone
    from dj.apps.dyte.models import RecordingDelivery
    from dj.apps.dyte.tasks import recover_recording_deliveries

    creator = creator_factory()
    now = timezone.now()
    receipt = RecordingDelivery.objects.create(
        idempotency_key=uuid.uuid4(),
        creator=creator,
        recovery_started_at=now - timedelta(
            seconds=settings.DYTE_RECORDING_STUCK_AFTER_SECONDS + 1),
        retry_exhausted_at=now,
    )

    with caplog.at_level(logging.ERROR):
        recover_recording_deliveries(0)

    assert receipt.idempotency_key
    assert 'RECORDING INGESTION STUCK' in caplog.text
    assert 'incomplete=1' in caplog.text


@pytest.mark.django_db
def test_recording_recovery_sweep_does_not_page_on_fresh_terminal_failure(
    creator_factory, caplog, settings,
):
    from django.utils import timezone
    from dj.apps.dyte.models import RecordingDelivery
    from dj.apps.dyte.tasks import recover_recording_deliveries

    creator = creator_factory()
    now = timezone.now()
    RecordingDelivery.objects.create(
        idempotency_key=uuid.uuid4(),
        creator=creator,
        recovery_started_at=now,
        retry_exhausted_at=now,
    )

    with caplog.at_level(logging.ERROR):
        recover_recording_deliveries(0)

    assert 'RECORDING INGESTION STUCK' not in caplog.text


@pytest.mark.django_db
@pytest.mark.parametrize('transient_status', [403, 404])
def test_transient_download_status_retries_and_ingests(
    mocker, creator_factory, _local_media, transient_status,
):
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu
    from dj.apps.dyte.models import RecordingDelivery
    from dj.apps.uploads.models import GenericFile

    creator = creator_factory()

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

    get = mocker.patch.object(
        dlu.requests, 'get', side_effect=[
            _Response(transient_status), _Response(200),
        ],
    )
    sleep = mocker.patch.object(dlu.time, 'sleep')
    recording_key = uuid.uuid4()
    message = _Message({
        'username': creator.username,
        'recording_idempotency_key': str(recording_key),
        'url': 'https://bucket.s3.amazonaws.com/recording.mp4?signature=old',
        'provider_event_id': str(uuid.uuid4()),
    })

    dlu.callback(message)

    assert message.acked is True
    assert message.nacked is False
    assert get.call_count == 2
    sleep.assert_called_once_with(1.0)
    assert GenericFile.objects.filter(owner=creator).count() == 1
    assert RecordingDelivery.objects.get(pk=recording_key).completed_at is not None


@pytest.mark.django_db
def test_refreshed_url_ingests_after_durable_recovery_scheduled(
    mocker, creator_factory, _local_media,
):
    """A fresh callback supersedes an already-scheduled recovery attempt."""
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu
    from dj.apps.dyte.models import RecordingDelivery
    from dj.apps.uploads.models import GenericFile

    creator = creator_factory()

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

    get = mocker.patch.object(
        dlu.requests, 'get', side_effect=[
            _Response(403), _Response(403), _Response(403), _Response(200),
        ],
    )
    mocker.patch.object(dlu.time, 'sleep')
    recording_key = uuid.uuid4()
    common = {
        'username': creator.username,
        'recording_idempotency_key': str(recording_key),
    }
    expired = _Message({
        **common,
        'url': 'https://bucket.s3.amazonaws.com/recording.mp4?signature=old',
        'provider_event_id': str(uuid.uuid4()),
    })
    refreshed = _Message({
        **common,
        'url': 'https://bucket.s3.amazonaws.com/recording.mp4?signature=new',
        'provider_event_id': str(uuid.uuid4()),
    })

    dlu.callback(expired)
    assert expired.acked is True
    failed = RecordingDelivery.objects.get(pk=recording_key)
    assert failed.completed_at is None
    assert failed.lease_expires_at <= dlu.timezone.now()

    dlu.callback(refreshed)

    assert refreshed.acked is True
    assert get.call_count == dlu.RECORDING_DOWNLOAD_MAX_ATTEMPTS + 1
    assert GenericFile.objects.filter(owner=creator).count() == 1
    assert RecordingDelivery.objects.get(pk=recording_key).completed_at is not None


@pytest.mark.django_db
def test_permanent_download_4xx_is_acked_and_terminalized(
    mocker, creator_factory, caplog,
):
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu

    creator = creator_factory()
    response = mocker.Mock(
        is_redirect=False,
        is_permanent_redirect=False,
        status_code=400,
        headers={},
    )
    get = mocker.patch.object(dlu.requests, 'get', return_value=response)
    sleep = mocker.patch.object(dlu.time, 'sleep')
    event_id = uuid.uuid4()
    message = _Message({
        'username': creator.username,
        'url': 'https://bucket.s3.amazonaws.com/invalid.mp4',
        'provider_event_id': str(event_id),
    })

    with caplog.at_level(logging.ERROR):
        dlu.callback(message)

    assert message.acked is True
    assert message.nacked is False
    get.assert_called_once()
    sleep.assert_not_called()
    delivery = dlu.RecordingDelivery.objects.get(pk=event_id)
    assert delivery.completed_at is None
    assert delivery.lease_expires_at <= dlu.timezone.now()
    assert delivery.retry_exhausted_at is not None
    assert delivery.download_url == ''
    assert delivery.last_failure_status == 400
    assert 'RECORDING DOWNLOAD RETRY EXHAUSTED' in caplog.text


@pytest.mark.django_db(transaction=True)
def test_recording_recovery_enqueue_is_deduplicated(creator_factory):
    from datetime import timedelta
    from django.utils import timezone
    from procrastinate.contrib.django.models import ProcrastinateJob
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu
    from dj.apps.dyte.models import RecordingDelivery

    receipt = RecordingDelivery.objects.create(
        idempotency_key=uuid.uuid4(),
        creator=creator_factory(),
        download_url='https://bucket.s3.amazonaws.com/recording.mp4',
        next_retry_at=timezone.now() + timedelta(minutes=1),
    )

    assert dlu.enqueue_recording_recovery(
        receipt.idempotency_key, receipt.next_retry_at)
    assert not dlu.enqueue_recording_recovery(
        receipt.idempotency_key, receipt.next_retry_at)

    jobs = ProcrastinateJob.objects.filter(
        task_name='dyte.retry_recording_delivery',
        args={'delivery_id': str(receipt.idempotency_key)},
    )
    assert jobs.count() == 1
    assert jobs.get().queue_name == 'recordings'
    assert jobs.get().scheduled_at == receipt.next_retry_at


@pytest.mark.django_db
def test_duplicate_recording_callback_preserves_failure_age(
    mocker, creator_factory, settings,
):
    from datetime import timedelta
    from django.utils import timezone
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu
    from dj.apps.dyte.models import RecordingDelivery

    settings.DYTE_RECORDING_RECOVERY_MAX_ATTEMPTS = 5
    creator = creator_factory()
    response = mocker.Mock(
        is_redirect=False,
        is_permanent_redirect=False,
        status_code=403,
        headers={},
    )
    mocker.patch.object(dlu.requests, 'get', return_value=response)
    mocker.patch.object(dlu.time, 'sleep')
    mocker.patch.object(dlu, 'enqueue_recording_recovery')
    event_id = uuid.uuid4()
    payload = {
        'username': creator.username,
        'url': 'https://bucket.s3.amazonaws.com/recording.mp4',
        'provider_event_id': str(event_id),
    }

    dlu.callback(_Message(payload))
    old_failure = timezone.now() - timedelta(hours=1)
    RecordingDelivery.objects.filter(pk=event_id).update(
        first_failure_at=old_failure,
    )
    dlu.callback(_Message(payload))

    receipt = RecordingDelivery.objects.get(pk=event_id)
    assert receipt.retry_count == 2
    assert receipt.first_failure_at == old_failure


@pytest.mark.django_db
def test_transient_download_failure_nacks_recording(mocker, creator_factory):
    from django.utils import timezone
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu

    creator = creator_factory()
    mocker.patch.object(
        dlu.requests,
        'get',
        side_effect=dlu.requests.exceptions.Timeout('S3 timed out'),
    )
    message = _Message({
        'username': creator.username,
        'url': 'https://bucket.s3.amazonaws.com/recording.mp4',
        'provider_event_id': str(uuid.uuid4()),
    })

    dlu.callback(message)

    assert message.nacked is True
    assert message.acked is False
    delivery = dlu.RecordingDelivery.objects.get(
        pk=uuid.UUID(json.loads(message.data)['provider_event_id']))
    assert delivery.lease_expires_at <= timezone.now()


@pytest.mark.django_db
@pytest.mark.parametrize(
    'failure_mode', [
        'allowlist', 'download', 'redirect', 'permanent_4xx',
        'transient_4xx', 'max_bytes',
    ],
)
def test_recording_failure_logs_never_expose_presigned_url(
    mocker, creator_factory, settings, caplog, failure_mode,
):
    """Provider capabilities never enter Cloud Logging on failure paths."""
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu

    creator = creator_factory()
    secret = f'presigned-{failure_mode}-secret'
    host = f'BEARER-{secret}.s3.amazonaws.com'
    url = (
        f'https://{host}/{secret}.mp4'
        f'?X-Amz-Signature={secret}&X-Amz-Credential=credential-{secret}'
    )
    if failure_mode == 'allowlist':
        url = url.replace(host, f'{secret}.evil.example')

    class _Response:
        is_redirect = False
        is_permanent_redirect = False
        status_code = 200
        headers = {}

        def raise_for_status(self):
            pass

        def iter_content(self, chunk_size=8192):
            yield b'too-large-for-cap'

        def close(self):
            pass

    response = _Response()
    if failure_mode == 'redirect':
        response.is_redirect = True
        response.status_code = 302
        response.headers = {
            'Location': (
                f'https://redirect-target.example/{secret}.mp4'
                f'?token={secret}'
            ),
        }
    elif failure_mode == 'permanent_4xx':
        response.status_code = 400
    elif failure_mode == 'transient_4xx':
        response.status_code = 403
    if failure_mode == 'download':
        get = mocker.patch.object(
            dlu.requests, 'get',
            side_effect=dlu.requests.exceptions.ConnectionError(
                f'GET {url} failed'),
        )
    else:
        get = mocker.patch.object(dlu.requests, 'get', return_value=response)
    if failure_mode == 'transient_4xx':
        mocker.patch.object(dlu.time, 'sleep')
    if failure_mode == 'max_bytes':
        settings.DYTE_RECORDING_MAX_BYTES = 1

    message = _Message({
        'username': creator.username,
        'url': url,
        'provider_event_id': str(uuid.uuid4()),
    })
    with caplog.at_level(logging.INFO):
        dlu.callback(message)

    assert secret not in caplog.text
    assert url not in caplog.text
    if failure_mode == 'allowlist':
        get.assert_not_called()
        assert 'https://<redacted>.evil.example' in caplog.text
    elif failure_mode == 'transient_4xx':
        assert get.call_count == dlu.RECORDING_DOWNLOAD_MAX_ATTEMPTS
    else:
        get.assert_called_once()
    if failure_mode == 'redirect':
        assert 'https://redirect-target.example' in caplog.text


@pytest.mark.parametrize(
    'field, log_prefix',
    [
        (
            'recording_idempotency_key',
            'Invalid recording_idempotency_key in message',
        ),
        (
            'provider_event_id',
            'Invalid provider_event_id in recording message',
        ),
    ],
)
def test_invalid_permanent_drop_logs_safe_identifier_context(
    caplog, field, log_prefix,
):
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu

    invalid_identifier = 'invalid-but-safe@provider'
    message = _Message({
        'username': 'alice',
        'url': 'https://bucket.s3.amazonaws.com/recording.mp4',
        field: invalid_identifier,
    })

    with caplog.at_level(logging.ERROR):
        dlu.callback(message)

    assert message.acked is True
    assert message.nacked is False
    assert f'{log_prefix}: {invalid_identifier}' in caplog.text


@pytest.mark.django_db
def test_slow_drip_download_hits_total_wall_clock_cap(
    mocker, creator_factory, settings,
):
    from django.utils import timezone
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu

    creator = creator_factory()
    settings.DYTE_RECORDING_TOTAL_TIMEOUT_SECONDS = 10

    class _Resp:
        is_redirect = False
        is_permanent_redirect = False
        status_code = 200
        headers = {}

        def raise_for_status(self):
            pass

        def iter_content(self, chunk_size=8192):
            yield b'dripped-too-late'

        def close(self):
            pass

    mocker.patch.object(dlu.requests, 'get', return_value=_Resp())
    mocker.patch.object(dlu.time, 'monotonic', side_effect=[0, 11])
    event_id = uuid.uuid4()
    message = _Message({
        'username': creator.username,
        'url': 'https://bucket.s3.amazonaws.com/recording.mp4',
        'provider_event_id': str(event_id),
    })

    dlu.callback(message)

    assert message.nacked is True
    assert message.acked is False
    delivery = dlu.RecordingDelivery.objects.get(pk=event_id)
    assert delivery.lease_expires_at <= timezone.now()


@pytest.mark.django_db
def test_takeover_during_upload_prevents_stale_owner_from_completing(
    mocker, creator_factory,
):
    from datetime import timedelta
    from django.utils import timezone
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu

    creator = creator_factory()
    event_id = uuid.uuid4()
    takeover_token = []

    class _Resp:
        is_redirect = False
        is_permanent_redirect = False
        status_code = 200
        headers = {}

        def raise_for_status(self):
            pass

        def iter_content(self, chunk_size=8192):
            yield b'video-bytes'

        def close(self):
            pass

    mocker.patch.object(dlu.requests, 'get', return_value=_Resp())
    fake_gfile = mocker.Mock()

    def take_over(*args, **kwargs):
        dlu.RecordingDelivery.objects.filter(pk=event_id).update(
            lease_expires_at=timezone.now() - timedelta(seconds=1))
        status, token = dlu.claim_recording(event_id)
        assert status == 'claimed'
        takeover_token.append(token)

        return 'recordings/stale-upload.mp4'

    fake_gfile.file.storage.save.side_effect = take_over
    mocker.patch.object(dlu, 'GenericFile', return_value=fake_gfile)
    message = _Message({
        'username': creator.username,
        'url': 'https://bucket.s3.amazonaws.com/recording.mp4',
        'provider_event_id': str(event_id),
    })

    dlu.callback(message)

    assert message.acked is True
    assert message.nacked is False
    fake_gfile.save.assert_not_called()
    delivery = dlu.RecordingDelivery.objects.get(pk=event_id)
    assert delivery.lease_token == takeover_token[0]
    assert delivery.completed_at is None
    fake_gfile.file.storage.delete.assert_called_once_with(
        'recordings/stale-upload.mp4')
    uploaded_name = fake_gfile.file.storage.save.call_args.args[0]
    assert uploaded_name.endswith('.mp4')
    assert str(takeover_token[0]) not in uploaded_name


@pytest.mark.django_db
def test_database_failure_after_upload_cleans_uncommitted_object(
    mocker, creator_factory,
):
    from django.db import OperationalError
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu

    creator = creator_factory()

    class _Resp:
        is_redirect = False
        is_permanent_redirect = False
        status_code = 200
        headers = {}

        def raise_for_status(self):
            pass

        def iter_content(self, chunk_size=8192):
            yield b'video-bytes'

        def close(self):
            pass

    mocker.patch.object(dlu.requests, 'get', return_value=_Resp())
    fake_gfile = mocker.Mock()
    fake_gfile.file.storage.save.return_value = 'creator/uncommitted.mp4'
    fake_gfile.save.side_effect = OperationalError('commit failed')
    mocker.patch.object(dlu, 'GenericFile', return_value=fake_gfile)
    message = _Message({
        'username': creator.username,
        'url': 'https://bucket.s3.amazonaws.com/recording.mp4',
        'provider_event_id': str(uuid.uuid4()),
    })

    dlu.callback(message)

    assert message.nacked is True
    assert message.acked is False
    fake_gfile.file.storage.delete.assert_called_once_with(
        'creator/uncommitted.mp4')


@pytest.mark.parametrize('payload', [
    b'not-json',
    b'[]',
    {},
    {'username': ['alice'], 'url': 'https://bucket.s3.amazonaws.com/a.mp4'},
    {'username': 'alice', 'url': []},
])
def test_malformed_queue_payload_is_acked(payload):
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu

    message = _Message(payload)

    dlu.callback(message)

    assert message.acked is True
    assert message.nacked is False


def test_command_limits_recording_subscription_to_one_message(mocker):
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu

    client = mocker.patch.object(dlu, 'PubSubClient').return_value

    dlu.Command().handle()

    assert client.subscribe.call_args.kwargs['flow_control'].max_messages == 1




@pytest.mark.django_db
def test_recording_receipt_does_not_prevent_creator_file_deletion(
    creator_factory, _local_media,
):
    from django.core.files.base import ContentFile
    from django.utils import timezone
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu
    from dj.apps.dyte.models import RecordingDelivery
    from dj.apps.uploads.models import GenericFile

    creator = creator_factory()
    gfile = GenericFile(
        owner=creator, title='recording', mime_type='video/mp4')
    gfile.file.save('recording.mp4', ContentFile(b'video'))
    receipt = RecordingDelivery.objects.create(
        idempotency_key=uuid.uuid4(), generic_file=gfile,
        completed_at=timezone.now(),
    )

    gfile.delete()

    receipt.refresh_from_db()
    assert receipt.generic_file is None
    assert receipt.completed_at is not None
    assert dlu.claim_recording(receipt.idempotency_key)[0] == 'completed'


@pytest.mark.django_db
def test_sink_refuses_a_recording_over_the_byte_cap(
    creator_factory, mocker, settings, _local_media
):
    settings.DYTE_RECORDING_MAX_BYTES = 10  # tiny cap for the test

    from dj.apps.dyte.management.commands import dyte_download_upload as dlu

    creator = creator_factory()

    class _Resp:
        is_redirect = False
        is_permanent_redirect = False
        headers = {}

        def raise_for_status(self):
            pass

        def iter_content(self, chunk_size=8192):
            yield b"way-more-than-ten-bytes-of-video"

        def close(self):
            pass

    mocker.patch.object(dlu.requests, "get", return_value=_Resp())

    msg = _Message({
        "username": creator.username,
        "url": "https://bucket.s3.amazonaws.com/rec.mp4",
    })
    dlu.callback(msg)

    assert msg.acked is True
    from dj.apps.uploads.models import GenericFile
    assert not GenericFile.objects.filter(owner=creator).exists()


@pytest.mark.django_db
def test_sink_refuses_a_redirecting_allowlisted_url(creator_factory, mocker):
    """An allowlisted host that 3xx's must not be followed onto an internal
    address — the redirect target is never re-checked."""
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu

    creator = creator_factory()

    class _Redirect:
        is_redirect = True
        is_permanent_redirect = False
        headers = {"Location": "http://169.254.169.254/latest/meta-data/"}

        def raise_for_status(self):
            raise AssertionError("must not reach raise_for_status")

        def close(self):
            pass

    mocker.patch.object(dlu.requests, "get", return_value=_Redirect())

    msg = _Message({
        "username": creator.username,
        "url": "https://bucket.s3.amazonaws.com/rec.mp4",
    })
    dlu.callback(msg)

    assert msg.acked is True
    from dj.apps.uploads.models import GenericFile
    assert not GenericFile.objects.filter(owner=creator).exists()


# --------------------------------------------------------------------------
# recording access tiering
# --------------------------------------------------------------------------

@pytest.mark.parametrize("meeting_type,expected", [
    ("broadcast", "public"),
    ("subscribers-only", "members"),
    ("ppv", "private"),
    ("private", "private"),
    ("bogus", "private"),
    (None, "private"),
])
def test_recording_access_for_meeting_type(meeting_type, expected):
    from dj.apps.dyte.management.commands.dyte_download_upload import (
        recording_access_for_meeting_type,
    )
    assert recording_access_for_meeting_type(meeting_type) == expected


@pytest.mark.django_db
@pytest.mark.parametrize("meeting_type,expected", [
    ("broadcast", "public"),
    ("subscribers-only", "members"),
    ("ppv", "private"),
    ("private", "private"),
])
def test_resolve_recording_access_maps_a_real_meeting_type(
        creator_factory, meeting_type, expected):
    from django.db import transaction
    from dj.apps.dyte.management.commands.dyte_download_upload import (
        resolve_recording_access,
    )
    from dj.apps.dyte.models import CreatorMeeting

    creator = creator_factory()
    meeting = CreatorMeeting.objects.create(
        creator=creator, meeting_type=meeting_type)
    # The resolver row-locks the matched meeting (select_for_update), which
    # requires an active atomic block; run the resolution inside one.
    with transaction.atomic():
        assert resolve_recording_access(
            {"meeting_pk": meeting.pk}, creator) == expected


@pytest.mark.django_db
def test_resolve_recording_access_is_fail_closed_without_a_meeting(
        creator_factory):
    """Absent/invalid/unresolvable `meeting_pk` must land at `private`, never
    `public` — a restricted recording must not leak because the payload omitted
    the meeting or the meeting row vanished."""
    from django.db import transaction
    from dj.apps.dyte.management.commands.dyte_download_upload import (
        resolve_recording_access,
    )
    from dj.apps.dyte.models import BROADCAST, CreatorMeeting

    creator = creator_factory()
    meeting = CreatorMeeting.objects.create(
        creator=creator, meeting_type=BROADCAST)

    # Not a dict at all.
    assert resolve_recording_access(None, creator) == "private"
    assert resolve_recording_access([], creator) == "private"
    # Missing key.
    assert resolve_recording_access({}, creator) == "private"
    # Non-int / bool / float / str that is not an int.
    assert resolve_recording_access(
        {"meeting_pk": "not-an-int"}, creator) == "private"
    assert resolve_recording_access({"meeting_pk": True}, creator) == "private"
    assert resolve_recording_access({"meeting_pk": 3.14}, creator) == "private"
    # A pk that no longer exists.
    assert resolve_recording_access(
        {"meeting_pk": 999_999_999}, creator) == "private"
    # A real meeting that exists -> public (inside atomic: the resolver
    # row-locks the matched meeting via select_for_update).
    with transaction.atomic():
        assert resolve_recording_access(
            {"meeting_pk": meeting.pk}, creator) == "public"


@pytest.mark.django_db
def test_resolve_recording_access_fails_closed_on_username_meeting_mismatch(
        creator_factory):
    """A `meeting_pk` naming another creator's broadcast meeting must NOT be
    honoured. The payload's username resolves `creator`; the meeting must
    belong to that same creator or the tier falls back to `private` — scoping
    the lookup by both `pk` and `creator` is what makes a mismatched payload
    fail closed instead of publishing someone else's broadcast as yours
    ."""
    from django.db import transaction
    from dj.apps.dyte.management.commands.dyte_download_upload import (
        resolve_recording_access,
    )
    from dj.apps.dyte.models import BROADCAST, CreatorMeeting

    owner = creator_factory(username="meeting-owner")
    other = creator_factory(username="meeting-other")

    # owner's own broadcast meeting resolves public...
    owners_broadcast = CreatorMeeting.objects.create(
        creator=owner, meeting_type=BROADCAST,
        meeting_id=str(uuid.uuid4()))
    #...but the very same meeting read as the *other* creator is private,
    # even though the other creator is a broadcast meeting owner themselves.
    others_broadcast = CreatorMeeting.objects.create(
        creator=other, meeting_type=BROADCAST,
        meeting_id=str(uuid.uuid4()))
    # The resolver row-locks the matched meeting (select_for_update), which
    # requires an active atomic block; run the resolutions inside one.
    with transaction.atomic():
        assert resolve_recording_access(
            {"meeting_pk": owners_broadcast.pk}, owner) == "public"
        assert resolve_recording_access(
            {"meeting_pk": owners_broadcast.pk}, other) == "private"
        assert resolve_recording_access(
            {"meeting_pk": others_broadcast.pk}, other) == "public"
        assert resolve_recording_access(
            {"meeting_pk": others_broadcast.pk}, owner) == "private"


@pytest.mark.django_db
def test_resolve_recording_access_ignores_a_non_public_meeting_row(
        creator_factory):
    """`is_public` is part of the authoritative lookup: a `broadcast` meeting
    row with `is_public=False` (the private variant) must fail closed to
    `private`, never resolve to `public`. Without the filter, a recording of a
    private room could ride its broadcast-typed row into the public bucket
    ( adversarial review)."""
    from django.db import transaction
    from dj.apps.dyte.management.commands.dyte_download_upload import (
        resolve_recording_access,
    )
    from dj.apps.dyte.models import BROADCAST, CreatorMeeting

    creator = creator_factory()
    private_broadcast = CreatorMeeting.objects.create(
        creator=creator, meeting_type=BROADCAST, is_public=False)
    assert private_broadcast.is_public is False

    with transaction.atomic():
        assert resolve_recording_access(
            {"meeting_pk": private_broadcast.pk}, creator) == "private"


@pytest.mark.django_db
def test_resolve_recording_access_row_locks_the_matched_meeting(
        creator_factory):
    """The authoritative access resolution must be a `SELECT... FOR UPDATE`
    against the matched CreatorMeeting. Acquiring the row lock inside the
    callback's same `transaction.atomic()` block means a concurrent
    `meeting_type` downgrade blocks until this transaction commits instead of
    committing between the access read and `gfile.save()` and leaving a stale
    public recording readable ( adversarial review)."""
    from django.db import connection, transaction
    from django.test.utils import CaptureQueriesContext
    from dj.apps.dyte.management.commands.dyte_download_upload import (
        resolve_recording_access,
    )
    from dj.apps.dyte.models import BROADCAST, CreatorMeeting

    creator = creator_factory()
    meeting = CreatorMeeting.objects.create(
        creator=creator, meeting_type=BROADCAST)

    with transaction.atomic():
        with CaptureQueriesContext(connection) as captured:
            assert resolve_recording_access(
                {"meeting_pk": meeting.pk}, creator) == "public"

    locks = [
        query for query in captured.captured_queries
        if "for update" in query["sql"].lower()
        and "dyte_creatormeeting" in query["sql"].lower()
    ]
    assert len(locks) == 1, (
        "the authoritative access resolution must row-lock the matched "
        "CreatorMeeting on PostgreSQL"
    )


def test_resolve_access_query_is_select_for_update():
    """The resolver's authoritative final read must issue exactly one
    `select_for_update()` rooted at `CreatorMeeting.objects`. Pinned at the
    source level because the row lock is the guarantee that a concurrent
    `meeting_type` downgrade cannot slip between the access read and
    `gfile.save()`; a direct race test cannot hit the window reliably
    ( adversarial review)."""
    from dj.apps.dyte.management.commands import dyte_download_upload
    module_path = Path(dyte_download_upload.__file__)

    tree = ast.parse(module_path.read_text())
    resolver = next(
        node for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef)
        and node.name == "resolve_recording_access"
    )

    def _is_meeting_row_lock(node):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "select_for_update"
        ):
            receiver = node.func.value
            return (
                isinstance(receiver, ast.Attribute)
                and receiver.attr == "objects"
                and isinstance(receiver.value, ast.Name)
                and receiver.value.id == "CreatorMeeting"
            )
        return False

    lock_calls = [
        node for node in ast.walk(resolver) if _is_meeting_row_lock(node)
    ]
    assert len(lock_calls) == 1, (
        "resolve_recording_access must row-lock the matched CreatorMeeting"
    )


def test_recording_access_is_resolved_inside_the_atomic_save_boundary():
    """The authoritative access tier is resolved inside the
    `transaction.atomic()` block immediately before `gfile.save()`, never at
    `GenericFile` construction time. A construction-time read could resolve a
    `meeting_type` that changed (was restricted) while the multi-GiB recording
    downloaded, and then publish a stale public row. A direct race test
    is impractical — the mutation would have to land in the window between
    construction and save — so the ordering is pinned at the source level.
    """
    from dj.apps.dyte.management.commands import dyte_download_upload
    module_path = Path(dyte_download_upload.__file__)

    tree = ast.parse(module_path.read_text())
    callback = next(
        node for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name == "callback"
    )

    def _is_resolve_call(node, with_node):
        if (isinstance(node.func, ast.Name)
                and node.func.id == "resolve_recording_access"):
            resolve_calls.append((node.lineno, with_node))

    def _is_gfile_save(node, with_node):
        if (isinstance(node.func, ast.Attribute)
                and node.func.attr == "save"
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "gfile"):
            save_calls.append((node.lineno, with_node))

    def _is_atomic(with_node):
        if with_node is None:
            return False
        # `context_expr` on ast.With was removed in Python 3.12; the
        # withitem form works on the 3.10 and 3.12 CI interpreters alike.
        expr = with_node.items[0].context_expr
        return (
            isinstance(expr, ast.Call)
            and isinstance(expr.func, ast.Attribute)
            and expr.func.attr == "atomic"
            and isinstance(expr.func.value, ast.Name)
            and expr.func.value.id == "transaction"
        )

    def visit(node, with_node):
        if isinstance(node, ast.Call):
            _is_resolve_call(node, with_node)
            _is_gfile_save(node, with_node)
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.With):
                visit(child, child)
            elif isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            else:
                visit(child, with_node)

    resolve_calls = []
    save_calls = []
    visit(callback, None)

    assert resolve_calls, "resolve_recording_access must be called in callback"
    assert save_calls, "gfile.save() must be called in callback"
    resolve_in_atomic = {
        id(with_node): lineno
        for lineno, with_node in resolve_calls if _is_atomic(with_node)
    }
    save_in_atomic = {
        id(with_node): lineno
        for lineno, with_node in save_calls if _is_atomic(with_node)
    }
    shared = set(resolve_in_atomic) & set(save_in_atomic)
    assert shared, (
        "resolve_recording_access and gfile.save() must share one "
        "transaction.atomic() block"
    )
    resolve_line = min(resolve_in_atomic[id_] for id_ in shared)
    save_line = min(save_in_atomic[id_] for id_ in shared)
    assert resolve_line < save_line, (
        "access resolution must run immediately before gfile.save()"
    )


# --------------------------------------------------------------------------
# Account deletion: the recording owner is the account id, never a name that
# can change hands (g12f.account_deletion frees a username after 30 days).
# --------------------------------------------------------------------------


class _OkResp:
    is_redirect = False
    is_permanent_redirect = False
    headers = {}

    def raise_for_status(self):
        pass

    def iter_content(self, chunk_size=8192):
        yield b"video-bytes"

    def close(self):
        pass


@pytest.mark.django_db
def test_a_recording_goes_to_the_account_id_not_whoever_has_the_name(
    creator_factory, mocker, _local_media,
):
    from django.utils import timezone

    from dj.apps.dyte.management.commands import dyte_download_upload as dlu
    from dj.apps.g12f.models import Creator
    from dj.apps.uploads.models import GenericFile

    owner = creator_factory(username="streamer")
    newcomer = creator_factory(username="newcomer")
    # The owner deletes their account; the name is later held by someone else.
    Creator.objects.filter(pk=owner.pk).update(
        is_active=False, deleted_at=timezone.now(), username="deleted_0123456789abcdef")
    Creator.objects.filter(pk=newcomer.pk).update(username="streamer")
    get = mocker.patch.object(dlu.requests, "get", return_value=_OkResp())

    msg = _Message({
        "creator_id": owner.pk,
        "username": "streamer",
        "url": "https://bucket.s3.us-east-1.amazonaws.com/rec-owner.mp4",
    })
    dlu.callback(msg)

    get.assert_not_called()
    assert msg.acked is True
    assert not GenericFile.objects.filter(owner=newcomer).exists()
    assert not GenericFile.objects.filter(owner=owner).exists()


@pytest.mark.django_db
def test_an_old_name_only_message_for_a_deleted_meeting_owner_is_dropped(
    creator_factory, mocker, _local_media,
):
    """A message queued before producers sent ``creator_id``."""
    from django.utils import timezone

    from dj.apps.dyte.management.commands import dyte_download_upload as dlu
    from dj.apps.dyte.models import BROADCAST, CreatorMeeting
    from dj.apps.g12f.models import Creator
    from dj.apps.uploads.models import GenericFile

    owner = creator_factory(username="streamer2")
    meeting = CreatorMeeting.objects.create(creator=owner, meeting_type=BROADCAST)
    newcomer = creator_factory(username="newcomer2")
    Creator.objects.filter(pk=owner.pk).update(
        is_active=False, deleted_at=timezone.now(), username="deleted_fedcba9876543210")
    Creator.objects.filter(pk=newcomer.pk).update(username="streamer2")
    get = mocker.patch.object(dlu.requests, "get", return_value=_OkResp())

    msg = _Message({
        "username": "streamer2",
        "meeting_pk": meeting.pk,
        "url": "https://bucket.s3.us-east-1.amazonaws.com/rec-old.mp4",
    })
    dlu.callback(msg)

    get.assert_not_called()
    assert msg.acked is True
    assert not GenericFile.objects.filter(owner=newcomer).exists()


@pytest.mark.django_db
def test_a_live_account_id_message_still_downloads(creator_factory, mocker, _local_media):
    from dj.apps.dyte.management.commands import dyte_download_upload as dlu
    from dj.apps.uploads.models import GenericFile

    creator = creator_factory()
    mocker.patch.object(dlu.requests, "get", return_value=_OkResp())
    msg = _Message({
        "creator_id": creator.pk,
        "username": creator.username,
        "url": "https://bucket.s3.us-east-1.amazonaws.com/rec-live.mp4",
    })
    dlu.callback(msg)
    assert msg.acked is True
    assert GenericFile.objects.filter(owner=creator).exists()


@pytest.mark.django_db
def test_an_account_deleted_during_the_download_gets_no_recording(
    creator_factory, mocker, _local_media,
):
    """The deletion check before the download is not enough: it can take
    minutes. The final save re-checks under the account lock."""
    from django.utils import timezone

    from dj.apps.dyte.management.commands import dyte_download_upload as dlu
    from dj.apps.g12f.models import Creator
    from dj.apps.uploads.models import GenericFile

    creator = creator_factory()

    class _DeletingResp(_OkResp):
        def iter_content(self, chunk_size=8192):
            Creator.objects.filter(pk=creator.pk).update(
                is_active=False, deleted_at=timezone.now())
            yield b"video-bytes"

    mocker.patch.object(dlu.requests, "get", return_value=_DeletingResp())
    msg = _Message({
        "creator_id": creator.pk,
        "username": creator.username,
        "url": "https://bucket.s3.us-east-1.amazonaws.com/rec-racing.mp4",
    })
    dlu.callback(msg)
    assert msg.acked is True
    assert not GenericFile.objects.filter(owner=creator).exists()
