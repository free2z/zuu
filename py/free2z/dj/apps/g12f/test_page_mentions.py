""": exact first-publication @mention notifications."""

import concurrent.futures
import threading
import time
import uuid
from datetime import timedelta

import pytest
from django.db import connections, transaction
from django.utils import timezone
from rest_framework.test import APIClient

from dj.apps.events.models import Event
from dj.apps.g12f.mentions import extract_mention_handles, process_page_mentions
from dj.apps.g12f.models import (
    CreatorBlock, CreatorMute, PageMentionDelivery, Subscription, zPage,
)
from dj.apps.g12f.tasks import publish_zpage
from dj.apps.tuzis import ledger



@pytest.fixture
def mention_creator_factory(creator_factory):
    def make_creator(**kwargs):
        creator = creator_factory(**kwargs)
        creator.mention_notifications_enabled = True
        creator.save(update_fields=['mention_notifications_enabled'])
        return creator

    return make_creator

def _page(author, **kwargs):
    values = {
        'creator': author,
        'free2zaddr': str(uuid.uuid4()),
        'title': 'A page',
        'content': 'Hello world',
        'is_published': True,
    }
    values.update(kwargs)
    return zPage.objects.create(**values)


def _process_in_worker(page_id):
    try:
        return process_page_mentions(page_id)
    finally:
        connections.close_all()


def test_extract_mentions_rejects_non_mentions_and_deduplicates():
    text = (
        '@alice @alice.smith, email alice@example.com and foo@alice. '
        '[ordinary @bob](https://example.test/post) '
        '[@carol](/carol)\n'
        'https://example.test/@george\n'
        '> @dave\n\n```\n@erin\n```\n`@frank`'
    )
    assert extract_mention_handles(text) == ['alice', 'alice.smith', 'carol']


def test_extract_mentions_matches_markdown_exclusions_and_text_order():
    assert extract_mention_handles(
        '[@alice][profile]\n\n[profile]: https://example.test\n'
        '<pre>@bob</pre>\n'
        '[@carol](https://evil.test/carol)\n'
        '\\@dave\n'
        '@erin @frank [@erin](/erin)'
    ) == ['erin', 'frank']


def test_extract_mentions_preserves_username_punctuation_without_partials():
    assert extract_mention_handles(
        '@.alice @bob+news @carol-name @dave_name '
        'email bob+news@example.com partial@carol-name'
    ) == ['.alice', 'bob+news', 'carol-name', 'dave_name']


def test_extract_mentions_bounds_hostile_inline_code_and_trims_one_punctuation():
    hostile = "`" * 5000 + " @hidden " + "`" * 5000
    assert extract_mention_handles(hostile + " @alice...") == ['alice...']


@pytest.mark.django_db
def test_mention_preference_defaults_to_opt_out(creator_factory):
    creator = creator_factory(username="default-opt-out")
    assert creator.mention_notifications_enabled is False


@pytest.mark.django_db
def test_punctuation_fallback_keeps_exact_punctuation_username_preferred(
    mention_creator_factory,
):
    author = mention_creator_factory(username="punct-author")
    plain = mention_creator_factory(username="bob")
    exact = mention_creator_factory(username="bob+")
    page = _page(author, content="@bob+ @missing+")

    assert process_page_mentions(page.pk)['sent'] == 1
    assert Event.objects.filter(
        type='PAGE_MENTION', receiving_user=exact,
    ).exists()
    assert not Event.objects.filter(
        type='PAGE_MENTION', receiving_user=plain,
    ).exists()


@pytest.mark.django_db(transaction=True)
def test_first_publication_delivers_only_eligible_unique_recipients(
    mention_creator_factory,
):
    author = mention_creator_factory(username='author')
    recipient = mention_creator_factory(username='alice')
    blocked = mention_creator_factory(username='blocked')
    muted = mention_creator_factory(username='muted')
    opted_out = mention_creator_factory(username='optedout')
    mention_creator_factory(username='inactive', is_active=False)
    CreatorBlock.objects.create(blocker=blocked, blocked=author)
    CreatorMute.objects.create(muter=muted, muted=author)
    opted_out.mention_notifications_enabled = False
    opted_out.save(update_fields=['mention_notifications_enabled'])

    page = _page(
        author,
            content=(
            '@alice. @alice [@alice](/alice) '
            '@blocked @muted @optedout @inactive @missing'
        ),
    )

    result = process_page_mentions(page.pk)

    assert result['sent'] == 1
    assert Event.objects.filter(type='PAGE_MENTION').count() == 1
    event = Event.objects.get(type='PAGE_MENTION')
    assert event.receiving_user_id == recipient.pk
    # Suppression telemetry is structured logging, not a content-retaining
    # ledger. Only actual sends are durable for rolling limits/cooldowns.
    assert PageMentionDelivery.objects.filter(zpage=page).count() == 1


@pytest.mark.django_db(transaction=True)
def test_page_and_author_caps_are_atomic_and_idempotent(mention_creator_factory):
    author = mention_creator_factory(username='author')
    recipients = [mention_creator_factory(username=f'user{i}') for i in range(6)]
    page = _page(
        author,
        content=' '.join(f'@{recipient.username}' for recipient in recipients),
    )

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(
            lambda _n: _process_in_worker(page.pk), range(2),
        ))

    assert sum(result['sent'] for result in results) == 5
    assert Event.objects.filter(type='PAGE_MENTION').count() == 5
    assert PageMentionDelivery.objects.filter(zpage=page).count() == 5
    page.refresh_from_db()
    assert page.mention_notifications_processed_at is not None

    later = _page(author, content='@user5')
    PageMentionDelivery.objects.filter(
        author=author, status=PageMentionDelivery.SENT,
    ).update(created_at=timezone.now() - timedelta(days=8))
    # The page above is eligible after the old deliveries leave the cooldown,
    # while the original page remains permanently idempotent.
    assert process_page_mentions(page.pk)['skipped'] == 1
    assert process_page_mentions(later.pk)['sent'] == 1


@pytest.mark.django_db
def test_stale_save_and_unpublish_republish_keep_marker_monotonic(mention_creator_factory):
    author = mention_creator_factory(username='author')
    first = mention_creator_factory(username='first')
    later = mention_creator_factory(username='later')
    page = _page(author, content='@first')
    stale_editor = zPage.objects.get(pk=page.pk)

    assert process_page_mentions(page.pk)['sent'] == 1
    page.refresh_from_db()
    marker = page.mention_notifications_processed_at
    assert marker is not None

    stale_editor.content = '@first @later'
    stale_editor.is_published = False
    stale_editor.published_at = None
    stale_editor.save()
    page.refresh_from_db()
    assert page.mention_notifications_processed_at == marker

    page.is_published = True
    page.save()
    assert process_page_mentions(page.pk)['skipped'] == 1
    assert Event.objects.filter(type='PAGE_MENTION').count() == 1
    assert first.pk != later.pk


@pytest.mark.django_db
def test_publication_api_and_edit_do_not_republish_mentions(
    mention_creator_factory, api_client,
):
    author = mention_creator_factory(username='author')
    recipient = mention_creator_factory(username='recipient')
    page = _page(
        author, is_published=False, content='@recipient', source_language='en',
    )
    api_client.force_authenticate(user=author)

    response = api_client.patch(
        f'/api/zpage/{page.free2zaddr}/',
        {'is_published': True}, format='json',
    )
    assert response.status_code == 200, response.data
    assert Event.objects.filter(
        type='PAGE_MENTION', receiving_user=recipient,
    ).count() == 1

    response = api_client.patch(
        f'/api/zpage/{page.free2zaddr}/',
        {'content': '@recipient @newmention', 'is_published': True},
        format='json',
    )
    assert response.status_code == 200, response.data

    translation = api_client.put(
        f'/api/zpage/{page.free2zaddr}/translations/es/',
        {
            'title': 'Título traducido',
            'content': '@newmention in imported translation text',
            'is_published': True,
            'tags': [],
        }, format='json',
    )
    assert translation.status_code == 200, translation.data
    assert Event.objects.filter(type='PAGE_MENTION').count() == 1


@pytest.mark.django_db
def test_scheduled_draft_publication_delivers_once(mention_creator_factory):
    author = mention_creator_factory(username='author')
    recipient = mention_creator_factory(username='scheduledrecipient')
    page = _page(
        author, is_published=False,
        publish_at=timezone.now() - timedelta(minutes=1),
        content='@scheduledrecipient',
    )

    publish_zpage(zpage_id=page.pk)
    assert Event.objects.filter(
        type='PAGE_MENTION', receiving_user=recipient,
    ).count() == 1
    assert process_page_mentions(page.pk)['skipped'] == 1


@pytest.mark.django_db(transaction=True)
def test_direct_and_scheduled_publication_race_has_one_delivery(
    mention_creator_factory,
):
    author = mention_creator_factory(username='race-author')
    recipient = mention_creator_factory(username='race-recipient')
    page = _page(
        author, is_published=False,
        publish_at=timezone.now() - timedelta(minutes=1),
        content='@race-recipient',
    )

    def direct_publish(_page_id):
        client = APIClient()
        client.force_authenticate(author)
        response = client.patch(
            f'/api/zpage/{page.free2zaddr}/',
            {'is_published': True}, format='json',
        )
        connections.close_all()
        return response.status_code

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(pool.map(
            lambda operation: operation(page.pk),
            [direct_publish, publish_zpage],
        ))

    assert statuses[0] == 200
    # Which side wins is scheduling, not contract: if the PATCH commits first
    # the task's compare-and-set matches nothing and returns False ("no-op").
    # The contract is exactly one delivery either way.
    assert statuses[1] in (True, False)
    assert Event.objects.filter(
        type='PAGE_MENTION', receiving_user=recipient,
    ).count() == 1


@pytest.mark.django_db(transaction=True)
def test_different_pages_by_one_author_are_concurrency_safe(mention_creator_factory):
    author = mention_creator_factory(username='author')
    recipients = [mention_creator_factory(username=f'parallel{i}') for i in range(2)]
    pages = [
        _page(author, content=f'@{recipient.username}')
        for recipient in recipients
    ]

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(_process_in_worker, [page.pk for page in pages]))

    assert [result['sent'] for result in results] == [1, 1]
    assert Event.objects.filter(type='PAGE_MENTION').count() == 2


@pytest.mark.django_db
def test_deleting_pages_does_not_reset_daily_or_pair_accounting(mention_creator_factory):
    author = mention_creator_factory(username='daily-author')
    recipients = [mention_creator_factory(username=f'daily{i}') for i in range(21)]
    pages = [
        _page(author, content=f'@{recipient.username}')
        for recipient in recipients
    ]
    for page in pages[:20]:
        assert process_page_mentions(page.pk)['sent'] == 1
    pages[0].delete()

    assert PageMentionDelivery.objects.filter(
        author=author, status=PageMentionDelivery.SENT,
    ).count() == 20
    assert PageMentionDelivery.objects.filter(zpage__isnull=True).exists()
    assert process_page_mentions(pages[20].pk)['sent'] == 0

    pair_author = mention_creator_factory(username='pair-author')
    pair_recipient = mention_creator_factory(username='pair-recipient')
    old_page = _page(pair_author, content='@pair-recipient')
    assert process_page_mentions(old_page.pk)['sent'] == 1
    pair_events = Event.objects.filter(
        type='PAGE_MENTION', receiving_user=pair_recipient,
    ).count()
    old_page.delete()
    new_page = _page(pair_author, content='@pair-recipient')
    assert process_page_mentions(new_page.pk)['sent'] == 0
    assert Event.objects.filter(
        type='PAGE_MENTION', receiving_user=pair_recipient,
    ).count() == pair_events


@pytest.mark.django_db
def test_relationship_api_is_idempotent_and_suppresses_mentions(
    mention_creator_factory, api_client,
):
    author = mention_creator_factory(username='author')
    target = mention_creator_factory(username='target')
    api_client.force_authenticate(user=target)
    block_url = f'/api/creator/{author.username}/block/'

    assert api_client.put(block_url, format='json').status_code == 200
    assert api_client.put(block_url, format='json').json()['active'] is True
    assert api_client.get(block_url).json()['active'] is True
    assert api_client.delete(block_url).json()['active'] is False
    assert api_client.put(block_url, format='json').status_code == 200

    page = _page(author, content='@target')
    assert process_page_mentions(page.pk)['sent'] == 0
    assert not Event.objects.filter(
        type='PAGE_MENTION', receiving_user=target,
    ).exists()

    api_client.force_authenticate(user=None)
    assert api_client.put(block_url, format='json').status_code == 403
    api_client.force_authenticate(user=author)
    assert api_client.put(
        f'/api/creator/{author.username}/block/', format='json',
    ).status_code == 400


@pytest.mark.django_db
def test_mute_and_opt_out_endpoints_suppress_without_outbound_delivery(
    mention_creator_factory, api_client,
):
    author = mention_creator_factory(username='author')
    muted = mention_creator_factory(username='muted')
    opted_out = mention_creator_factory(username='opted-out')
    api_client.force_authenticate(user=muted)
    assert api_client.put(
        f'/api/creator/{author.username}/mute/', format='json',
    ).status_code == 200
    api_client.force_authenticate(user=opted_out)
    preference_url = '/api/events/mention-preference/'
    assert api_client.patch(
        preference_url, {'enabled': False}, format='json',
    ).json() == {'enabled': False}
    assert api_client.get(preference_url).json() == {'enabled': False}

    process_page_mentions(_page(author, content='@muted @opted-out').pk)
    assert not Event.objects.filter(type='PAGE_MENTION').exists()


@pytest.mark.django_db
def test_restricted_page_requires_active_subscription_and_event_redacts_access(
    mention_creator_factory, api_client,
):
    author = mention_creator_factory(username='author')
    subscriber = mention_creator_factory(username='subscriber')
    outsider = mention_creator_factory(username='outsider')
    page = _page(
        author,
        is_subscriber_only=True,
        content='@subscriber @outsider',
    )
    Subscription.objects.create(
        star=author,
        fan=subscriber,
        expires=timezone.now() + timedelta(days=1),
    )
    process_page_mentions(page.pk)
    assert Event.objects.filter(
        type='PAGE_MENTION', receiving_user=subscriber,
    ).count() == 1
    assert not Event.objects.filter(
        type='PAGE_MENTION', receiving_user=outsider,
    ).exists()

    api_client.force_authenticate(user=subscriber)
    subscriber_response = api_client.get('/api/events/')
    before_expiry = subscriber_response.json()['results'][0]
    assert before_expiry['content_url']
    assert before_expiry['content_title'] == 'A page'
    assert before_expiry['content_available'] is True
    realtime_before_expiry = Event.objects.get(
        type='PAGE_MENTION', receiving_user=subscriber,
    ).to_dict()
    assert realtime_before_expiry['content_url'] == before_expiry['content_url']
    assert realtime_before_expiry['content_title'] == 'A page'
    assert realtime_before_expiry['content_available'] is True
    assert realtime_before_expiry['message'] == before_expiry['message']

    Subscription.objects.filter(star=author, fan=subscriber).update(
        expires=timezone.now() - timedelta(seconds=1),
    )
    subscriber_response = api_client.get('/api/events/')
    event_data = subscriber_response.json()['results'][0]
    assert event_data['content_url'] is None
    assert event_data['content_title'] is None
    assert event_data['content_available'] is False
    assert 'A page' not in event_data['message']

    realtime_data = Event.objects.get(
        type='PAGE_MENTION', receiving_user=subscriber,
    ).to_dict()
    assert realtime_data['content_available'] is False
    assert realtime_data['content_url'] is None
    assert realtime_data['content_title'] is None
    assert realtime_data['message'] == event_data['message']


@pytest.mark.django_db
def test_banned_or_deleted_page_mentions_are_unavailable_not_untitled(
    mention_creator_factory, api_client,
):
    author = mention_creator_factory(username='moderated-author')
    recipient = mention_creator_factory(username='moderated-recipient')
    page = _page(author, content='@moderated-recipient', title='Secret page')
    process_page_mentions(page.pk)
    event = Event.objects.get(type='PAGE_MENTION', receiving_user=recipient)

    author.is_active = False
    author.save(update_fields=['is_active'])
    api_client.force_authenticate(user=recipient)
    banned_data = api_client.get('/api/events/').json()['results'][0]
    assert banned_data['content_available'] is False
    assert banned_data['content_title'] is None
    assert banned_data['content_url'] is None
    assert event.to_dict()['content_available'] is False

    author.is_active = True
    author.save(update_fields=['is_active'])
    page.refresh_from_db()
    page.title = ''
    page.save(update_fields=['title'])
    event.refresh_from_db()
    untitled = event.to_dict()
    assert untitled['content_available'] is True
    assert untitled['content_title'] is None
    assert untitled['content_url']

    page.delete()
    event.refresh_from_db()
    deleted = event.to_dict()
    assert deleted['content_available'] is False
    assert deleted['content_title'] is None
    assert deleted['content_url'] is None
    assert deleted['message'] == 'This content is no longer available.'

    deleted_api = api_client.get('/api/events/').json()['results'][0]
    assert deleted_api['content_available'] is False
    assert deleted_api['content_title'] is None
    assert deleted_api['content_url'] is None
    assert deleted_api['message'] == 'This content is no longer available.'


def test_length_cap_does_not_split_a_trailing_handle():
    from dj.apps.g12f.mentions import MAX_MENTION_TEXT_CHARS

    padding = "x" * (MAX_MENTION_TEXT_CHARS - 7)
    assert extract_mention_handles(padding + " @alicebob") == []
    assert extract_mention_handles(" @carol " + padding + " @alicebob") == [
        'carol',
    ]


def test_malformed_link_is_not_a_mention_and_does_not_raise():
    # urlsplit("http://[") raises ValueError("Invalid IPv6 URL"). Raised here it
    # rolled back the publication, and the scheduled task would hit the same
    # stored content on every retry.
    assert extract_mention_handles('[@alice](http://[) @bob') == ['bob']


@pytest.mark.django_db
def test_lookup_uses_lower_not_casefold(mention_creator_factory):
    # "Straße".casefold() == "strasse", a different account; Postgres LOWER()
    # keeps the sharp s. The mention must reach the account that was named.
    author = mention_creator_factory(username='sharp-author')
    named = mention_creator_factory(username='straße')
    other = mention_creator_factory(username='strasse')
    page = _page(author, content='hi @Straße')

    assert process_page_mentions(page.pk)['sent'] == 1
    assert Event.objects.filter(
        type='PAGE_MENTION', receiving_user=named,
    ).exists()
    assert not Event.objects.filter(
        type='PAGE_MENTION', receiving_user=other,
    ).exists()


@pytest.mark.django_db
def test_legacy_case_twins_need_an_exact_spelling(mention_creator_factory):
    # 0110 keeps pre-existing case-variant duplicate groups. Never guess.
    author = mention_creator_factory(username='twin-author')
    lower = mention_creator_factory(username='twin')
    upper = mention_creator_factory(
        username='Twin', username_ci_legacy='Twin',
    )
    exact_page = _page(author, content='@Twin')
    assert process_page_mentions(exact_page.pk)['sent'] == 1
    assert list(
        Event.objects.filter(type='PAGE_MENTION')
        .values_list('receiving_user_id', flat=True)
    ) == [upper.pk]

    ambiguous_page = _page(author, content='@TWIN')
    assert process_page_mentions(ambiguous_page.pk)['sent'] == 0
    assert not Event.objects.filter(
        type='PAGE_MENTION', receiving_user=lower,
    ).exists()


@pytest.mark.django_db(transaction=True)
def test_published_save_does_not_invert_the_ledger_lock_order(
    mention_creator_factory,
):
    """Creator row first, then the zPage (tuzis.ledger.lock_in_order).

    publish_page() runs process_page_mentions() on EVERY save of a published
    page, after zPage.save() already holds the page row. It used to lock the
    author's Creator row second (select_related + bare select_for_update, then
    Creator.objects.select_for_update()), so the author voting on / funding /
    buying a translation of that page at the same moment deadlocked with an
    ordinary autosave. Both the already-processed page and a true first
    publication are covered.
    """
    author = mention_creator_factory(username='lock-author')
    mention_creator_factory(username='lock-recipient')
    processed = _page(author, content='plain')
    process_page_mentions(processed.pk)
    first = _page(author, content='hi @lock-recipient')

    for page in (processed, first):
        barrier = threading.Barrier(2)
        errors = []

        def ledger_writer(page_id=page.pk):
            try:
                with transaction.atomic():
                    ledger.lock_in_order(author)
                    barrier.wait()
                    time.sleep(0.3)
                    zPage.objects.select_for_update(of=('self',)).get(
                        pk=page_id,
                    )
            except Exception as exc:  # pragma: no cover - the failure mode
                errors.append(('ledger', repr(exc)))
            finally:
                connections.close_all()

        def published_save(page_id=page.pk):
            try:
                with transaction.atomic():
                    fresh = zPage.objects.get(pk=page_id)
                    fresh.content = fresh.content + ' edited'
                    fresh.save()
                    barrier.wait()
                    time.sleep(0.3)
                    process_page_mentions(page_id)
            except Exception as exc:  # pragma: no cover - the failure mode
                errors.append(('save', repr(exc)))
            finally:
                connections.close_all()

        threads = [
            threading.Thread(target=ledger_writer),
            threading.Thread(target=published_save),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)
        assert errors == [], errors

    assert Event.objects.filter(type='PAGE_MENTION').count() == 1
