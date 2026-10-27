"""Provider billing facts that affect AI usage metering and price cards."""

# These APIs include image processing in reported input-token usage. A
# separate per-image price would count the same image a second time.
TOKEN_BILLED_IMAGE_PROVIDERS = frozenset({"openai", "anthropic"})
