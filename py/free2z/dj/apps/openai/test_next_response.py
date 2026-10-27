"""Tests for ``Conversation.generate`` / ``Conversation.persist_response``.

Regression coverage for the production bug where the AI reply crashed with an
``AttributeError`` because the generator called ``group_send`` on a ``None``
channel layer (the WebSocket layer isn't available on the deployed API pods),
turning the whole HTTP reply into a 503.

The live-token WebSocket push is an OPTIONAL side-channel; the accumulated
``response`` is the authoritative reply returned over HTTP and must always come
back in full, regardless of channel-layer availability.

These tests are hermetic: the provider stream and the channel layer are both
mocked, so no network / redis is required.
"""

import asyncio
import time
from unittest import mock

from django.test import TestCase

from dj.apps.g12f.models import Creator

from .models import (
    AI_LIVE_STREAM_PUSH_TIMEOUT_SECONDS,
    AIModel,
    Conversation,
    PromptResponse,
)


class NextResponseTestCase(TestCase):
    """Exercise the WS best-effort behavior of ``Conversation.generate``."""

    WORDS = ["Hello", ", ", "world", "!"]

    def setUp(self) -> None:
        self.user = Creator.objects.create(username="ai-user", tuzis=1000)
        self.ai_model = AIModel.objects.create(
            provider="openai",
            model="gpt-4o",
            display_name="GPT-4o",
            system_message="You are a helpful assistant.",
            # Large enough that the token-trimming loop never fires.
            max_tokens=100000,
        )
        self.conversation = Conversation.objects.create(
            ai_model=self.ai_model,
            user=self.user,
            display_name="Test conversation",
        )
        return super().setUp()

    def _fake_stream(self, *args, **kwargs):
        """Stand-in for ``stream_chat`` yielding provider-agnostic deltas."""
        for word in self.WORDS:
            yield word

    def test_none_channel_layer_does_not_raise(self):
        """Test A (regression): a ``None`` channel layer must not crash the reply.

        This reproduces the reported production bug: ``get_channel_layer()``
        returns ``None`` on the API pods, so the old code did
        ``None.group_send`` and raised ``AttributeError`` → 503. The reply must
        now come back fully with the WS push simply skipped.
        """
        with mock.patch(
            "f2z.ai.providers.stream_chat", side_effect=self._fake_stream
        ), mock.patch(
            "dj.apps.openai.models.get_channel_layer", return_value=None
        ):
            response, input_tokens, output_tokens, _usage = (
                self.conversation.generate("hi there")
            )

        prompt_response = self.conversation.persist_response(
            "hi there", response
        )
        self.assertIsInstance(prompt_response, PromptResponse)
        self.assertEqual(prompt_response.response, "".join(self.WORDS))
        self.assertEqual(prompt_response.user_input, "hi there")
        # Persisted and attached to the conversation.
        self.assertIn(
            prompt_response, self.conversation.prompt_response_set.all()
        )

    def test_group_send_failure_is_swallowed(self):
        """Test B: a failing ``group_send`` must not abort the reply."""
        channel_layer = mock.Mock()
        channel_layer.group_send.side_effect = RuntimeError("no redis here")

        with mock.patch(
            "f2z.ai.providers.stream_chat", side_effect=self._fake_stream
        ), mock.patch(
            "dj.apps.openai.models.get_channel_layer",
            return_value=channel_layer,
        ):
            response, _, _, _ = self.conversation.generate("hi")

        # Full reply still returned despite the WS push blowing up.
        self.assertEqual(response, "".join(self.WORDS))

    def test_happy_path_streams_each_word(self):
        """Test C: with a working layer, push once per word and return in full."""
        # Channels' ``group_send`` is a coroutine, so ``async_to_sync`` awaits
        # it — the mock must be awaitable.
        channel_layer = mock.Mock()
        channel_layer.group_send = mock.AsyncMock()

        with mock.patch(
            "f2z.ai.providers.stream_chat", side_effect=self._fake_stream
        ), mock.patch(
            "dj.apps.openai.models.get_channel_layer",
            return_value=channel_layer,
        ):
            response, _, _, _ = self.conversation.generate("hi")

        self.assertEqual(response, "".join(self.WORDS))
        self.assertEqual(channel_layer.group_send.call_count, len(self.WORDS))
        # Each push targets this conversation's group with a send_word message.
        for call, word in zip(
            channel_layer.group_send.call_args_list, self.WORDS
        ):
            group, message = call.args
            self.assertEqual(group, f"conversation_{self.conversation.id}")
            self.assertEqual(message, {"type": "send_word", "message": word})

    def test_group_send_timeout_is_abandoned_promptly_and_disables_streaming(self):
        """A stalling/hung group_send must be abandoned promptly.

        Live token push is best-effort. When group_send blocks or hangs (e.g.
        Redis is stalling), the call must timeout promptly at
        AI_LIVE_STREAM_PUSH_TIMEOUT_SECONDS without blocking the sync worker,
        streaming must be disabled after the failure, and the authoritative
        HTTP response must still accumulate fully.
        """
        async def slow_group_send(*args, **kwargs):
            await asyncio.sleep(10.0)

        channel_layer = mock.Mock()
        channel_layer.group_send = mock.AsyncMock(side_effect=slow_group_send)

        t0 = time.monotonic()
        with mock.patch(
            "f2z.ai.providers.stream_chat", side_effect=self._fake_stream
        ), mock.patch(
            "dj.apps.openai.models.get_channel_layer",
            return_value=channel_layer,
        ), mock.patch(
            "dj.apps.openai.models.AI_LIVE_STREAM_PUSH_TIMEOUT_SECONDS", 0.05
        ):
            response, _, _, _ = self.conversation.generate("hi")

        elapsed = time.monotonic() - t0
        # Finished promptly: one short push timeout (~0.05s) plus generator overhead,
        # well below the 10s hung sleep.
        self.assertLess(elapsed, 2.0)
        # Full response is still accumulated and returned over HTTP.
        self.assertEqual(response, "".join(self.WORDS))
        # group_send was abandoned and disabled after the first failed word.
        self.assertEqual(channel_layer.group_send.call_count, 1)

    def test_group_send_timeout_constant_is_bounded(self):
        """Ensure named constant is configured and appropriately small."""
        self.assertIsInstance(AI_LIVE_STREAM_PUSH_TIMEOUT_SECONDS, (int, float))
        self.assertGreater(AI_LIVE_STREAM_PUSH_TIMEOUT_SECONDS, 0)
        self.assertLessEqual(AI_LIVE_STREAM_PUSH_TIMEOUT_SECONDS, 2.0)


class StreamOpenAICompatibleTestCase(TestCase):
    """The OpenAI-compatible stream must tolerate a stray empty-``choices`` chunk."""

    def test_empty_choices_chunk_is_skipped(self):
        from f2z.ai import providers

        def _chunk(content=None, choices=None):
            m = mock.Mock()
            if choices is not None:
                m.choices = choices
            elif content is None:
                # Empty-choices, usage-only chunk (e.g. with stream_options).
                m.choices = []
            else:
                delta = mock.Mock()
                delta.content = content
                choice = mock.Mock()
                choice.delta = delta
                m.choices = [choice]
            return m

        # A real delta, an empty-choices usage chunk, a None-content delta,
        # then a final real delta.
        none_delta = mock.Mock()
        none_delta_choice = mock.Mock()
        none_delta_content = mock.Mock()
        none_delta_content.content = None
        none_delta_choice.delta = none_delta_content
        none_delta.choices = [none_delta_choice]

        fake_response = [
            _chunk("Hello"),
            _chunk(),  # empty choices -> must be skipped, not IndexError
            none_delta,  # None content -> skipped, not AttributeError
            _chunk(" world"),
        ]

        fake_client = mock.Mock()
        fake_client.chat.completions.create.return_value = fake_response

        with mock.patch.object(providers, "get_client", return_value=fake_client):
            words = list(
                providers.stream_openai_compatible(
                    "openai", "gpt-4o", [{"role": "user", "content": "hi"}]
                )
            )

        self.assertEqual(words, ["Hello", " world"])
