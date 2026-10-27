"""Prompt-cache price fractions shared by Django settlement and card seeding.

The fractions are the audited policy on the current rate-card seed. Keep them
as exact integer ratios so admission can compare rates without float rounding.
"""
from fractions import Fraction

from f2z.ai.providers import ANTHROPIC, KIMI, OPENAI, XAI


CACHE_PRICE_FRACTIONS = {
    ANTHROPIC: ((1, 10), (5, 4), (2, 1)),
    OPENAI: ((1, 1), (1, 1), (1, 1)),
    XAI: ((1, 1), (1, 1), (1, 1)),
    KIMI: ((1, 1), (1, 1), (1, 1)),
}

_OPENAI_CACHE_READ_ONLY = ((1, 10), (1, 1), (1, 1))
_OPENAI_WRITE_BILLED = ((1, 10), (5, 4), (5, 4))
MODEL_CACHE_PRICE_FRACTIONS = {
    (OPENAI, "gpt-4o"): ((1, 2), (1, 1), (1, 1)),
    (OPENAI, "gpt-4o-mini"): ((1, 2), (1, 1), (1, 1)),
    (OPENAI, "gpt-6.1-sol"): ((1, 20), (5, 4), (5, 4)),
    (OPENAI, "gpt-6-astra"): _OPENAI_WRITE_BILLED,
    (OPENAI, "gpt-6-sol"): _OPENAI_WRITE_BILLED,
    (OPENAI, "gpt-6-luna"): _OPENAI_WRITE_BILLED,
    (OPENAI, "gpt-5.6-sol"): _OPENAI_WRITE_BILLED,
    (OPENAI, "gpt-5.6-terra"): _OPENAI_WRITE_BILLED,
    (OPENAI, "gpt-5.6-luna"): _OPENAI_WRITE_BILLED,
    (OPENAI, "gpt-5.5"): _OPENAI_CACHE_READ_ONLY,
    (OPENAI, "gpt-5.4"): _OPENAI_CACHE_READ_ONLY,
    (OPENAI, "gpt-5.4-mini"): _OPENAI_CACHE_READ_ONLY,
    (OPENAI, "gpt-5.4-nano"): _OPENAI_CACHE_READ_ONLY,
    (OPENAI, "gpt-5.2"): _OPENAI_CACHE_READ_ONLY,
    (OPENAI, "gpt-5.1"): _OPENAI_CACHE_READ_ONLY,
    (OPENAI, "gpt-5"): _OPENAI_CACHE_READ_ONLY,
    (OPENAI, "gpt-5-mini"): _OPENAI_CACHE_READ_ONLY,
    (OPENAI, "gpt-5-nano"): _OPENAI_CACHE_READ_ONLY,
    (OPENAI, "gpt-4.1"): ((1, 4), (1, 1), (1, 1)),
    (OPENAI, "gpt-4.1-mini"): ((1, 4), (1, 1), (1, 1)),
    (OPENAI, "gpt-4.1-nano"): ((1, 4), (1, 1), (1, 1)),
    (OPENAI, "o3"): ((1, 4), (1, 1), (1, 1)),
    (OPENAI, "o4-mini"): ((1, 4), (1, 1), (1, 1)),
    (OPENAI, "o3-mini"): ((1, 2), (1, 1), (1, 1)),
    (OPENAI, "o1"): ((1, 2), (1, 1), (1, 1)),
    (XAI, "grok-4.5"): ((3, 20), (1, 1), (1, 1)),
    (XAI, "grok-4.3"): ((4, 25), (1, 1), (1, 1)),
    (KIMI, "kimi-k3"): ((1, 10), (1, 1), (2, 1)),
    (KIMI, "kimi-k2.6"): ((16, 95), (1, 1), (1, 1)),
}


def cache_price_fractions(provider, model):
    """Return (cached read, 5m write, 1h write) ratios for a model."""
    return MODEL_CACHE_PRICE_FRACTIONS.get(
        (provider, model), CACHE_PRICE_FRACTIONS.get(
            provider, ((1, 1), (1, 1), (1, 1))))


def max_input_price_fraction(provider, model):
    """Highest cache-class rate, compared as a rational value."""
    highest = max(Fraction(*fraction)
                  for fraction in cache_price_fractions(provider, model))
    return highest.numerator, highest.denominator
