"""
Bounds on the OpenAI calls the search indexing tasks make.

`search.index_zpage` and `search.index_multilingual_zpage` used the openai
SDK's implicit module-level client, which sets neither `timeout` nor
`max_retries` and therefore takes the SDK defaults: 600s per request, 2
retries. The bounded client uses the configured timeout and retry count for
both calls; reclaim_policy derives its runtime allowance from those same
settings, plus task overhead and the shared reclaim margin. With defaults,
the provider-call ceiling is 360s, the runtime allowance is 600s, and the
reclaim threshold is 900s -- below the 3600s health backstop.

Four tests, because there are four separate ways this can be wrong:

1. the client is actually constructed with the settings (a knob nobody
   reads is not a bound);
2. the resulting arithmetic is under the reclaimer's floor (the number has
   to be the RIGHT number, not merely present);
3. the openai SDK honours `timeout` at all, proven against a real socket
   that never answers -- because everything above is arithmetic over an
   assumption about somebody else's library;
4. the call sites actually USE that client rather than the SDK's implicit,
   unbounded module-level proxies.
"""
import socket
import threading
import time

import openai
import pytest
from django.conf import settings
from django.test import override_settings

from dj.apps.search import helpers


@pytest.fixture(autouse=True)
def _reset_memoised_client():
    """The client is memoised; each test must build its own."""
    helpers._client = None
    yield
    helpers._client = None


def test_the_indexing_client_is_built_from_the_settings(mocker):
    built = mocker.patch.object(openai, "OpenAI")
    with override_settings(
        SEARCH_OPENAI_TIMEOUT_SECONDS=60.0, SEARCH_OPENAI_MAX_RETRIES=2
    ):
        client = helpers.get_openai_client()

    built.assert_called_once_with(timeout=60.0, max_retries=2)
    assert client is built.return_value

    # Memoised: one client for the process, not one per call.
    assert helpers.get_openai_client() is client
    assert built.call_count == 1


def test_the_worst_case_index_job_matches_its_reclaim_budget():
    """The runtime policy follows the same configured client bounds."""
    from dj.apps.jobs import reclaim, reclaim_policy

    calls_per_job = 2
    attempts = 1 + settings.SEARCH_OPENAI_MAX_RETRIES
    worst_case = calls_per_job * attempts * settings.SEARCH_OPENAI_TIMEOUT_SECONDS

    assert worst_case == 360.0
    for task_name in (
        'search.index_zpage', 'search.index_multilingual_zpage',
    ):
        policy = reclaim_policy.policy_for(task_name)
        assert policy.max_runtime_seconds == (
            worst_case + reclaim_policy.SEARCH_INDEX_TASK_OVERHEAD_SECONDS
        )
        assert reclaim.task_threshold_seconds(task_name) == (
            policy.max_runtime_seconds
            + settings.JOB_RECLAIM_BUDGET_MARGIN_SECONDS
        )
        assert worst_case < policy.max_runtime_seconds


def test_the_openai_sdk_actually_honours_the_timeout():
    """The knob is real: a black-holed endpoint fails, it does not hang.

    A listener that accepts the TCP connection and then says nothing is
    exactly the failure mode a missing timeout turns into an unkillable
    worker. Runs on a daemon thread so "never returned" is an assertion
    rather than a CI-cap hang (pytest-timeout is not a dependency here).
    """
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", 0))
    server.listen(8)
    host, port = server.getsockname()
    held = []
    stop = threading.Event()

    def _accept():
        server.settimeout(0.2)
        while not stop.is_set():
            try:
                conn, _ = server.accept()
            except (socket.timeout, OSError):
                continue
            held.append(conn)

    accepting = threading.Thread(target=_accept, daemon=True)
    accepting.start()

    box = {}

    def _call():
        # max_retries=0 so this measures ONE attempt's timeout.
        client = openai.OpenAI(
            api_key="test-key-not-used",
            base_url=f"http://{host}:{port}/v1",
            timeout=1.0,
            max_retries=0,
        )
        started = time.monotonic()
        try:
            client.embeddings.create(
                input=["hello"], model="text-embedding-3-small")
        except BaseException as exc:  # noqa: BLE001 - reporting, not handling
            box["error"] = exc
        box["elapsed"] = time.monotonic() - started

    caller = threading.Thread(target=_call, daemon=True)
    caller.start()
    caller.join(timeout=20)
    alive = caller.is_alive()

    stop.set()
    accepting.join(timeout=5)
    for conn in held:
        try:
            conn.close()
        except OSError:
            pass
    server.close()

    assert not alive, (
        "the openai client never returned against a socket that accepts and "
        "never answers -- `timeout=` is not bounding the request"
    )
    assert isinstance(box.get("error"), openai.APITimeoutError), box
    assert box["elapsed"] < 15, box["elapsed"]


def test_the_indexing_calls_go_through_the_bounded_client(mocker):
    """Behavioural control: neither call may reach the SDK's implicit client.

    `openai.completions` / `openai.embeddings` are module-level proxies that
    lazily build an UNBOUNDED client (timeout=600, max_retries=2). Asserting
    only on how our client is constructed would still pass if a call site
    kept using those proxies, so assert on which object the two calls
    actually land on.
    """
    from dj.apps.search.models import PageContext, Summary

    bounded = mocker.MagicMock(name="bounded_client")
    bounded.chat.completions.create.return_value = mocker.Mock(
        choices=[mocker.Mock(message=mocker.Mock(content=" summary "))])
    bounded.embeddings.create.return_value = mocker.Mock(
        data=[mocker.Mock(embedding=[0.5, 0.25])])
    mocker.patch.object(openai, "OpenAI", return_value=bounded)

    # The unbounded module-level proxies. If a call site still uses them,
    # these record it.
    implicit_completions = mocker.patch.object(openai, "completions")
    implicit_chat = mocker.patch.object(openai, "chat")
    implicit_embeddings = mocker.patch.object(openai, "embeddings")

    summary = helpers.generate_summary(PageContext(
        title="t", content="c", author="a", tags=[]))
    vector = helpers.generate_vector(Summary(text=summary.text))

    assert summary.text == "summary"
    assert vector == [0.5, 0.25]
    assert bounded.chat.completions.create.call_count == 1
    assert bounded.completions.create.call_count == 0, (
        "generate_summary used the legacy Completions API (#2294)"
    )
    assert bounded.embeddings.create.call_count == 1
    assert implicit_completions.create.call_count == 0, (
        "generate_summary used openai.completions -- the SDK's implicit, "
        "unbounded (600s x 3) module-level client"
    )
    assert implicit_chat.completions.create.call_count == 0, (
        "generate_summary used openai.chat -- the SDK's implicit, "
        "unbounded (600s x 3) module-level client"
    )
    assert implicit_embeddings.create.call_count == 0, (
        "generate_vector used openai.embeddings -- the SDK's implicit, "
        "unbounded (600s x 3) module-level client"
    )
