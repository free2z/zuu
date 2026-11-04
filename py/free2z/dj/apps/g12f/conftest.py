"""Shared fixtures for the g12f suites.

WHY THIS FILE EXISTS: THE TOKENIZER CACHES ARE PROCESS-WIDE
------------------------------------------------------------
``dj.apps.g12f.translation.service`` memoises four things derived from the
tiktoken vocabulary, all of them deliberately -- they sit in the per-fragment
hot loop of a paid translation:

``_tokenizer_fidelity``   which encoding we asked for versus which we got
``_reference_tokens``     the parallel corpus, counted per model
``output_token_ratio``    the measured per-language expansion built from it
``_tag_fallbacks``        pure string work, listed for completeness

Several tests in this package legitimately replace ``num_tokens_from_text``,
``num_tokens_from_messages`` or ``openai.models._get_encoding`` with a stub, so
that the RELATIONSHIP between two encodings can be asserted without depending on
a BPE download. An ``lru_cache`` does not care that the stub has been removed
again: whichever test happens to call one of these functions FIRST decides the
value every later test in the process sees.

That bit, exactly. ``test_translation_quality.py``'s per-script ratio assertions
passed alone and failed in the full run, because a stubbed tokenizer in
``test_translation_service.py`` got there first and the real measurement was
never taken. The failure is order-dependent, so it looks like a flake and it
changes as tests are added.

Clearing before AND after every test is deliberate. Before, so a test cannot
inherit a poisoned value; after, so a test cannot leave one behind for something
outside this package. It costs microseconds and it is the only thing that makes
these suites order-independent.

It is also a fair model of production: the caches are pinned for the life of a
process there too, which is why ``_tokenizer_fidelity``'s own docstring argues
that its conservative verdict is the safe one to pin.
"""
import pytest


@pytest.fixture(autouse=True)
def _clear_tokenizer_caches():
    from dj.apps.g12f.translation import service

    cached = (
        service._tokenizer_fidelity,
        service._reference_tokens,
        service.output_token_ratio,
        service._tag_fallbacks,
    )
    for function in cached:
        function.cache_clear()
    yield
    for function in cached:
        function.cache_clear()
