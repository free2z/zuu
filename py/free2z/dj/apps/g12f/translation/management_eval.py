"""Manual, bounded real-output evaluation for the translation sell list.

This module intentionally records provider output only after an operator opts
in. The default path is a priced plan with no provider I/O.
"""
import hashlib
import json
import math
import re
from decimal import Decimal
from datetime import datetime, timezone
from pathlib import Path

from dj.apps.g12f.translation import scripts, service
from f2z import languages

SAMPLE = {
    "title": "Free2Z and Zcash",
    "description": "A synthetic guide to 2Z and ZEC.",
    "content": "Free2Z uses 2Z. Zcash uses ZEC. This synthetic sample contains no personal data.",
    "source_language": "en",
}
BRANDS = ("Free2Z", "2Z", "Zcash", "ZEC")
BRAND_PATTERNS = {
    "Free2Z": re.compile(r"(?<![\w])Free2Z(?![\w])", re.IGNORECASE),
    "2Z": re.compile(r"(?<![\w])2Z(?![\w])", re.IGNORECASE),
    "Zcash": re.compile(r"(?<![\w])Zcash(?![\w])", re.IGNORECASE),
    "ZEC": re.compile(r"(?<![\w])ZEC(?![\w])", re.IGNORECASE),
}


def digest(value):
    raw = value if isinstance(value, bytes) else json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode()
    return hashlib.sha256(raw).hexdigest()


def validate_languages(codes):
    if not codes:
        raise ValueError("select at least one language")
    unknown = set(codes) - languages.TRANSLATABLE
    if unknown:
        raise ValueError(f"not TRANSLATABLE: {sorted(unknown)}")
    return tuple(codes)


def score_reply(reply, language):
    script = service.target_script(language)
    mismatch = scripts.script_mismatch(reply, script) if script else None
    try:
        service._require_target_script([reply], language)
        gate_result = "no_opinion" if not script or scripts.script_share(reply, script)[1] < scripts.MIN_SCRIPT_CHARS else "accepted"
    except service.TranslationFailed as exc:
        gate_result = "rejected"
        error = type(exc).__name__
    else:
        error = None
    return {
        "script_conformance": mismatch,
        "require_target_script": gate_result,
        "brand_terms_survived": {
            term: len(BRAND_PATTERNS[term].findall(reply)) >= (2 if term == "2Z" else 1)
            for term in BRANDS
        },
        "human_review_needed": language in {"zh-Hans", "zh-Hant"},
        "error": error,
    }


def maximum_provider_usd(model, target_language):
    """Worst-case provider cost using exact production plan, caps and retry."""
    units = service.plan_document(
        SAMPLE["title"], SAMPLE["description"], SAMPLE["content"],
        ai_model=model, source_language="en", target_language=target_language,
    )
    total = Decimal(0)
    for unit in units:
        if unit.kind != service.TRANSLATE:
            continue
        prompt = service.build_messages(unit.text, "en", target_language, unit.context)
        retry_prompt = service.build_messages(
            unit.text, "en", target_language, unit.context,
            strict=True, anti_echo=True,
        )
        input_cap = max(service.provider_message_tokens(model, prompt),
                        service.provider_message_tokens(model, retry_prompt))
        input_cap *= service.ATTEMPTS_PER_FRAGMENT
        source_cap = service.provider_tokens(model, unit.text)
        output_cap = service._output_cap(model, source_cap, "en", target_language)
        output_cap = min(model.get_max_response_tokens(),
                         math.ceil(output_cap * service.CAP_RETRY_MULTIPLIER))
        output_cap += service._output_cap(model, source_cap, "en", target_language)
        total += model.get_provider_input_cost(input_cap)
        total += Decimal(output_cap) * Decimal(str(model.output_price))
    if not total.is_finite() or total < 0:
        raise ValueError("model pricing cannot establish a finite provider-cost bound")
    return total


def run(*, model, languages_to_run, call_provider=False, spend_cap=None, on_estimate=None,
        on_record=None):
    """Build report. Provider adapter is service.translate_document itself."""
    languages_to_run = tuple(dict.fromkeys(validate_languages(languages_to_run)))
    if call_provider and (spend_cap is None or not spend_cap.is_finite() or spend_cap <= 0):
        raise ValueError("--execute requires a finite positive provider USD cap")
    plan = []
    quotes = {}
    for code in languages_to_run:
        quote = service.quote_document(**SAMPLE, target_language=code,
                                       ai_model=model, source_digest=digest(SAMPLE))
        quotes[code] = quote
        maximum = maximum_provider_usd(model, code) if call_provider else Decimal(0)
        plan.append({"language": code, "creator_quote_2z": str(quote.price),
                     "max_provider_usd": str(maximum)})
    estimate = sum((q.price for q in quotes.values()), start=0)
    provider_maximum = sum((Decimal(row["max_provider_usd"]) for row in plan), Decimal(0))
    if call_provider and provider_maximum > spend_cap:
        raise ValueError(f"maximum provider cost {provider_maximum} USD exceeds cap {spend_cap} USD")
    if on_estimate:
        on_estimate(estimate)
    record = {
        "schema": "free2z.translation-eval.v1",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "model": f"{model.provider}/{model.model}",
        "model_pricing": {
            "input_usd_per_token": str(model.input_price),
            "output_usd_per_token": str(model.output_price),
            "max_response_tokens": model.get_max_response_tokens(),
        },
        "prompt_source": "dj.apps.g12f.translation.service.build_messages",
        "pricing_prompt_sha256_by_language_context": {
            code: digest(service.build_messages(
                SAMPLE[SAMPLE_KEY], "en", code, context,
                nonce=service.PRICING_NONCE,
            )) for code in languages_to_run for context, SAMPLE_KEY in (
                ("title", "title"), ("description", "description"), ("body", "content"),
            )
        },
        "sample_sha256": digest(SAMPLE),
        "source_sha256": {
            "service": digest(Path(service.__file__).read_bytes()),
            "scripts": digest(Path(scripts.__file__).read_bytes()),
            "evaluator": digest(Path(__file__).read_bytes()),
        },
        "creator_quote_estimate_2z": str(estimate),
        "maximum_provider_cost_usd": str(provider_maximum),
        "provider_cost_cap_usd": str(spend_cap) if call_provider else None,
        "immutable_estimate": True,
        "provider_calls_enabled": call_provider, "languages": {},
    }
    for code in languages_to_run:
        row = {"creator_quote_estimate_2z": str(quotes[code].price),
               "maximum_provider_cost_usd": str(plan[languages_to_run.index(code)]["max_provider_usd"]),
               "status": "planned"}
        record["languages"][code] = row
        if call_provider:
            row["status"] = "running"
            if on_record:
                on_record(record)
            def observe(text, input_tokens, output_tokens, messages):
                row.setdefault("raw_replies", []).append(text)
                row.setdefault("provider_attempt_usage", []).append({
                    "input_tokens": input_tokens, "output_tokens": output_tokens,
                })
                row.setdefault("request_prompt_digests", []).append(digest(messages))
                if on_record:
                    on_record(record)
            try:
                result = service.translate_document(
                    title=SAMPLE["title"], description=SAMPLE["description"],
                    content=SAMPLE["content"], source_language="en",
                    target_language=code, ai_model=model,
                    output_observer=observe,
                )
            except service.TranslationFailed as exc:
                replies = row.get("raw_replies", [])
                row.update(status="error", error_type=type(exc).__name__,
                           require_target_script="rejected" if exc.code == "wrong_script" else "not_reached")
                if replies:
                    reply = "\n".join(replies)
                    row.update(score_reply(reply, code))
                    row["require_target_script"] = "rejected" if exc.code == "wrong_script" else row["require_target_script"]
                    row["reply"] = reply
            else:
                if not result.input_tokens or not result.output_tokens:
                    row.update(status="error", error_type="MissingProviderUsage")
                    record["languages"][code] = row
                    continue
                reply = "\n".join((result.raw_title, result.raw_description, result.content))
                row.update(score_reply(reply, code))
                row.update(status="recorded", reply=reply,
                           provider_usage={"input_tokens": result.input_tokens,
                                           "output_tokens": result.output_tokens})
        record["languages"][code] = row
        if on_record:
            on_record(record)
    return record
