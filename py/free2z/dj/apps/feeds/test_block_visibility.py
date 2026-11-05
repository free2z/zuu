"""RSS visibility follows the session actor without sharing cached responses."""
import uuid

import pytest
from django.test import Client

from dj.apps.comments.models import Comment
from dj.apps.g12f.models import CreatorBlock, zPage
from dj.apps.openai.models import AIModel, Conversation, PromptResponse
from dj.apps.uploads.models import GenericFile


@pytest.mark.django_db
def test_all_feeds_use_session_block_and_preserve_public_visibility(creator_factory, monkeypatch):
    # Enclosure metadata is normally fetched from object storage; these
    # fixtures exercise visibility without making an external storage call.
    from dj.apps.feeds.views import zPageFeed
    monkeypatch.setattr(zPageFeed, 'item_enclosure_length', lambda self, item: 1)
    blocker = creator_factory(username='rss_blocker')
    blocked = creator_factory(username='rss_blocked')
    other = creator_factory(username='rss_other')
    CreatorBlock.objects.create(blocker=blocker, blocked=blocked)
    model = AIModel.objects.create(model='rss-test', display_name='Test',
                                   system_message='help', max_tokens=4096)
    for author, label in ((blocked, 'hidden'), (other, 'visible')):
        audio = GenericFile.objects.create(owner=author, file=f'test/{label}.mp3',
                                           mime_type='audio/mpeg')
        zPage.objects.create(creator=author, free2zaddr=str(uuid.uuid4()),
                             vanity=f'rss-{label}', title=f'{label} page',
                             content='text', is_published=True, enclosure=audio)
        Comment.objects.create(author=author, content=f'{label} comment')
        convo = Conversation.objects.create(user=author, ai_model=model,
                                            display_name=f'{label} conversation',
                                            is_public=True)
        prompt = PromptResponse.objects.create(user=author, ai_model=model,
                                               user_input=f'{label} prompt', response='ok')
        convo.prompt_response_set.add(prompt)

    # A nonblocked conversation may contain a response by a blocked author.
    # Its description must not surface that response even though the
    # conversation itself stays visible.
    mixed = Conversation.objects.create(user=other, ai_model=model,
                                        display_name='mixed conversation', is_public=True)
    mixed.prompt_response_set.add(PromptResponse.objects.create(
        user=blocked, ai_model=model, user_input='mixed secret', response='ok',
    ))

    routes = [
        ('/feeds/zpages/recent.xml', 'page'),
        ('/feeds/podcasts/recent.xml', 'page'),
        ('/feeds/converse/recent.xml', 'comment'),
        ('/feeds/ai/recent.xml', 'conversation'),
        (f'/feeds/{blocked.username}/zpages/recent.xml', 'page'),
        (f'/feeds/{blocked.username}/podcasts/recent.xml', 'page'),
        (f'/feeds/{blocked.username}/converse/recent.xml', 'comment'),
        (f'/feeds/{blocked.username}/ai/recent.xml', 'conversation'),
    ]
    for user, hidden in ((blocker, True), (other, False), (None, False)):
        client = Client()
        if user:
            client.force_login(user)
        for url, kind in routes:
            response = client.get(url)
            assert response.status_code == 200, (url, response.content)
            assert (f'hidden {kind}'.encode() in response.content) != hidden
            if url == '/feeds/ai/recent.xml':
                assert b'mixed conversation' in response.content
                assert (b'mixed secret' in response.content) != hidden
            if f'/{blocked.username}/' not in url:
                assert f'visible {kind}'.encode() in response.content
            assert 'private' in response['Cache-Control']
            assert 'no-store' in response['Cache-Control']
            assert {'cookie', 'authorization'} <= {
                value.strip().lower() for value in response['Vary'].split(',')
            }
