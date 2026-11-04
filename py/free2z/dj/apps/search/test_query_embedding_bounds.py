""": the search box's OpenAI call is bounded, and degrades to full text.

``VectorSearchFilter`` embeds the user's query INSIDE the ``/api/zpage/``
request. It used the SDK's implicit module-level client -- 600s read x 3
attempts (``openai/_constants.py``) -- on a pod with one sync gunicorn worker
. Now it goes through ``query_embedding_client()`` with a short budget
and no retry, and a provider that does not answer degrades search to Postgres
full-text instead of failing it.

Real socket, real SDK: a mock cannot hang, so it cannot prove a timeout.
Negative control, run while writing this: with ``max_retries=0`` and the
``timeout`` removed from ``query_embedding_client``, the request waits out the
blackhole's hold and fails the elapsed-time assertion.
"""

import socket
import threading
import time
import uuid

import openai
import pytest
from django.test import override_settings

from dj.apps.g12f.models import zPage
from dj.apps.search import drf_filters

HOLD_SECONDS = 10.0


class _Blackhole:
    def __init__(self):
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(8)
        self.server.settimeout(0.1)
        self.accepted = 0
        self._held = []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        while not self._stop.is_set():
            try:
                conn, _ = self.server.accept()
            except (socket.timeout, OSError):
                pass
            else:
                self.accepted += 1
                self._held.append((time.monotonic(), conn))
            for opened, conn in list(self._held):
                if time.monotonic() - opened >= HOLD_SECONDS:
                    conn.close()
                    self._held.remove((opened, conn))

    def __enter__(self):
        self._thread.start()
        host, port = self.server.getsockname()
        self.base_url = f"http://{host}:{port}/v1"
        return self

    def __exit__(self, *exc):
        self._stop.set()
        self._thread.join(timeout=5)
        for _, conn in self._held:
            conn.close()
        self.server.close()
        return False


@pytest.mark.django_db
def test_a_hung_embedding_provider_degrades_search_to_full_text(
    api_client, creator_factory, monkeypatch,
):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key-not-used")
    page = zPage.objects.create(
        creator=creator_factory(),
        free2zaddr=str(uuid.uuid4()),
        vanity="privacy-fallback",
        title="Privacy",
        content="An article about privacy.",
        is_published=True,
    )

    with _Blackhole() as provider, override_settings(
        SEARCH_QUERY_EMBED_TIMEOUT_SECONDS=0.5,
    ):
        monkeypatch.setattr(
            drf_filters, "get_openai_client",
            lambda: openai.OpenAI(
                api_key="test-key-not-used", base_url=provider.base_url,
            ),
        )
        started = time.monotonic()
        response = api_client.get("/api/zpage/?search=privacy")
        elapsed = time.monotonic() - started

    # Exactly one attempt: the web path takes no SDK retry.
    assert provider.accepted == 1, provider.accepted
    assert elapsed < 5, elapsed
    assert response.status_code == 200, response.content
    assert [item["vanity"] for item in response.json()["results"]] == [
        page.vanity
    ]


def test_the_query_client_is_bounded_and_does_not_retry(mocker):
    base = mocker.Mock()
    mocker.patch.object(drf_filters, "get_openai_client", return_value=base)
    with override_settings(SEARCH_QUERY_EMBED_TIMEOUT_SECONDS=8.0):
        drf_filters.query_embedding_client()

    kwargs = base.with_options.call_args.kwargs
    assert kwargs["max_retries"] == 0
    timeout = kwargs["timeout"]
    assert timeout.connect == 3.05
    assert timeout.read == 8.0
