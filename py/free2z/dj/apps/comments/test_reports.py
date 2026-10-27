"""Report intake must not expose private targets or another reporter's data."""
import json
import logging
import uuid
from datetime import timedelta

import pytest
from django.contrib import admin
from django.contrib.contenttypes.models import ContentType
from django.core.cache import cache
from django.utils import timezone

from .admin import ContentReportAdmin
from .models import Comment, ContentReport
from .reports import CONTENT_REPORT_RECEIVED_EVENT
from dj.apps.g12f.models import zPage

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def clear_throttle():
    cache.clear()


def submit(client, target, kind='creator', **extra):
    return client.post('/api/reports/', {
        'target_kind': kind, 'target_id': str(target), 'reason': 'csae',
        'details': 'Please investigate', **extra,
    }, format='json')


def test_auth_private_receipt_and_duplicate(api_client, creator_factory):
    reporter, target, other = [creator_factory() for _ in range(3)]
    assert submit(api_client, target.username).status_code in (401, 403)
    api_client.force_authenticate(reporter)
    first = submit(api_client, target.username, reporter=other.pk, status='resolved', staff_notes='injected')
    assert first.status_code == 201
    report = ContentReport.objects.get()
    assert report.reporter == reporter and report.status == 'open' and report.staff_notes == ''
    assert set(first.data) == {'id', 'created_at'}
    retry = submit(api_client, target.username, details='replace the original')
    assert retry.data == first.data
    report.refresh_from_db()
    assert report.details == 'Please investigate'
    assert report.target_id == str(target.pk)
    target.username = 'renamed-report-target'
    target.save(update_fields=['username'])
    assert submit(api_client, target.username).data == first.data
    api_client.force_authenticate(other)
    assert api_client.get('/api/reports/').status_code == 405
    assert api_client.get(f'/api/reports/{report.pk}/').status_code == 404
    assert submit(api_client, target.username).data['id'] != first.data['id']


def test_target_visibility_and_taxonomy(api_client, creator_factory):
    owner, reporter = creator_factory(), creator_factory()
    api_client.force_authenticate(reporter)
    page = zPage.objects.create(creator=owner, title='private', content='secret',
                               free2zaddr=str(uuid.uuid4()), vanity='private', is_published=False)
    comment = Comment.objects.create(author=owner, content='private reply',
        content_type=ContentType.objects.get_for_model(zPage), object_id=str(page.pk))
    for target, kind in [(page.free2zaddr, 'zpage'), (comment.pk, 'comment')]:
        assert submit(api_client, target, kind).status_code == 404
    page.is_published = True
    page.is_subscriber_only = True
    page.save()
    assert submit(api_client, page.free2zaddr, 'zpage').status_code == 404
    page.is_subscriber_only = False
    page.save()
    assert submit(api_client, page.free2zaddr, 'zpage').status_code == 201
    assert submit(api_client, comment.pk, 'comment').status_code == 201
    owner.is_active = False
    owner.save(update_fields=['is_active'])
    assert submit(api_client, owner.username).status_code == 404
    assert submit(api_client, 'bad uuid', 'comment').status_code == 404
    assert submit(api_client, '9' * 100).status_code == 404
    assert submit(api_client, reporter.username, reason='made-up').status_code == 400
    assert submit(api_client, reporter.username, details='x' * 2001).status_code == 400
    comment.is_banned = True
    comment.save(update_fields=['is_banned'])
    assert submit(api_client, comment.pk, 'comment').status_code == 404
    assert ContentReport.objects.count() == 2


def test_durable_report_cap_and_retry(api_client, creator_factory):
    reporter, target = creator_factory(), creator_factory()
    api_client.force_authenticate(reporter)
    first = submit(api_client, target.username)
    ContentReport.objects.bulk_create([ContentReport(reporter=reporter,
        target_kind='creator', target_id=str(i + 100000), reason='spam') for i in range(19)])
    assert submit(api_client, target.username, reason='other').status_code == 429
    assert submit(api_client, target.username).data == first.data
    assert ContentReport.objects.count() == 20
    ContentReport.objects.update(created_at=timezone.now() - timedelta(hours=2))
    assert submit(api_client, target.username, reason='other').status_code == 201


def test_invalid_requests_are_throttled(api_client, creator_factory):
    api_client.force_authenticate(creator_factory())
    for _ in range(30):
        assert submit(api_client, 'invalid').status_code == 404
    assert submit(api_client, 'invalid').status_code == 429


def test_priority_queue_preserves_report_after_target_deletion(api_client, creator_factory):
    reporter, target = creator_factory(), creator_factory()
    api_client.force_authenticate(reporter)
    submit(api_client, target.username, reason='spam')
    urgent = submit(api_client, target.username)
    queue = ContentReportAdmin(ContentReport, admin.site)
    assert str(queue.get_queryset(None).first().pk) == urgent.data['id']
    assert not queue.has_delete_permission(None)
    target.delete()
    assert ContentReport.objects.count() == 2
    reporter.delete()
    assert not ContentReport.objects.exclude(reporter=None).exists()


@pytest.mark.django_db(transaction=True)
def test_concurrent_reporters_last_slot_is_not_double_spent(creator_factory):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from django.db import close_old_connections, connections
    from rest_framework.test import APIClient

    reporter, target = creator_factory(), creator_factory()
    ContentReport.objects.bulk_create([ContentReport(reporter=reporter,
        target_kind='creator', target_id=str(i + 100000), reason='spam') for i in range(19)])
    barrier = Barrier(2)

    def send(reason):
        close_old_connections()
        try:
            client = APIClient()
            client.force_authenticate(reporter)
            barrier.wait(timeout=10)
            return submit(client, target.username, reason=reason).status_code
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(send, ['csae', 'other'])) == [201, 429]
    assert ContentReport.objects.count() == 20


def test_full_length_public_identifiers_remain_reportable(api_client, creator_factory):
    reporter = creator_factory()
    target = creator_factory(username='a' * 150)
    api_client.force_authenticate(reporter)
    assert submit(api_client, target.username).status_code == 201
    page = zPage.objects.create(creator=target, title='public', content='content',
        free2zaddr='p' * 128, vanity='long-id', is_published=True)
    assert submit(api_client, page.free2zaddr, 'zpage').status_code == 201
    assert ContentReport.objects.get(target_kind='creator').target_id == str(target.pk)
    assert ContentReport.objects.get(target_kind='zpage').target_id == page.free2zaddr


def _staff_alerts(caplog):
    return [
        json.loads(record.getMessage()) for record in caplog.records
        if record.name == 'dj.apps.comments.reports'
    ]


def test_new_report_alerts_staff_once_without_user_data(
    api_client, creator_factory, caplog, django_capture_on_commit_callbacks,
):
    """monitoring/log-metrics/content-report-received.json counts this line."""
    reporter, target = creator_factory(), creator_factory()
    api_client.force_authenticate(reporter)
    caplog.set_level(logging.WARNING, logger='dj.apps.comments.reports')

    with django_capture_on_commit_callbacks(execute=True):
        first = submit(api_client, target.username, details='secret evidence')
    assert first.status_code == 201
    with django_capture_on_commit_callbacks(execute=True):
        assert submit(api_client, target.username).data == first.data
    with django_capture_on_commit_callbacks(execute=True):
        spam = submit(api_client, target.username, reason='spam')
    assert spam.status_code == 201

    alerts = _staff_alerts(caplog)
    # The duplicate retry does not re-notify; a new reason is a new report.
    assert [a['reason'] for a in alerts] == ['csae', 'spam']
    assert alerts[0] == {
        'severity': 'WARNING',
        'message': (
            f"New content report {first.data['id']} (csae, creator) is "
            "waiting in the staff queue."
        ),
        'event': CONTENT_REPORT_RECEIVED_EVENT,
        'report_id': str(first.data['id']),
        'reason': 'csae',
        'target_kind': 'creator',
    }
    assert CONTENT_REPORT_RECEIVED_EVENT == 'content_report_received'
    raw = caplog.text
    assert 'secret evidence' not in raw
    assert target.username not in raw and reporter.username not in raw


def test_rejected_report_does_not_alert(
    api_client, creator_factory, caplog, django_capture_on_commit_callbacks,
):
    api_client.force_authenticate(creator_factory())
    caplog.set_level(logging.WARNING, logger='dj.apps.comments.reports')
    with django_capture_on_commit_callbacks(execute=True):
        assert submit(api_client, 'no-such-creator').status_code == 404
    assert _staff_alerts(caplog) == []


def test_alert_does_not_depend_on_an_on_commit_callback(
    api_client, creator_factory, caplog,
):
    """A worker lost between COMMIT and an on_commit callback must not drop a
    CSAE alert: the test transaction never commits, so only a line written
    with the report itself is seen here."""
    api_client.force_authenticate(creator_factory())
    caplog.set_level(logging.WARNING, logger='dj.apps.comments.reports')
    assert submit(api_client, creator_factory().username).status_code == 201
    assert [a['reason'] for a in _staff_alerts(caplog)] == ['csae']
