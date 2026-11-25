"""Manual, paid provider measurements; never invoked by the test suite."""
import json
import secrets
import time
from datetime import datetime, timezone

from django.core.management.base import BaseCommand, CommandError

from dj.apps.g12f.translation import service
from dj.apps.openai.models import AIModel
from f2z.ai.providers import policy_disabled_reason, provider_is_configured, stream_chat

# A fixed, public, non-user source. Long enough to observe a stream; short
# enough to keep five calls per model modest. Do not repeat a single sentence:
# expansion depends on the actual text, not just the target script.
SOURCE = """A community library opened beside the river last spring. Volunteers sorted books, repaired shelves, and invited neighbours to share ideas for the space. Each morning children arrive with questions, while older visitors read newspapers or help someone find a story. The library also lends tools and holds workshops on growing food, repairing clothes, and using computers. No one needs to pay to enter.

One rainy afternoon the electricity failed. Instead of closing, the staff moved chairs near the windows and began reading aloud. People who had never met stayed to listen and talked about the places where they grew up. By evening the lights returned, but several visitors asked whether the reading could become a regular event. The volunteers agreed to try it every month and to welcome stories in any language.

The project has not solved every problem in the neighbourhood. Its budget remains small, and some residents cannot easily reach the building. The organisers are asking what would make the service more useful, including delivery for people who cannot travel. They plan to publish the answers and explain which changes they can afford. A good public space grows through patience, practical work, and the participation of the people it serves."""
LANGUAGES = ("lo", "am", "si", "km", "my")


def measure(model, language):
    """Record complete or partial stream diagnostics without recording its text."""
    nonce = secrets.token_hex(8)
    source_tokens = service.provider_tokens(model, SOURCE)
    cap = service._output_cap(model, source_tokens, "en", language)
    messages = service.build_messages(SOURCE, "en", language, nonce=nonce)
    started = time.monotonic()
    stream = None
    first = last = None
    first_piece = ""
    parts = []
    chars = 0
    failure = None
    error_type = None
    try:
        stream = stream_chat(model, messages, timeout=service.REQUEST_TIMEOUT_SECONDS,
                             max_retries=0, max_output_tokens=cap, emit_keepalive=True)
        for delta in stream:
            now = time.monotonic()
            if delta:
                if first is None:
                    first, first_piece = now, delta
                last = now
                parts.append(delta)
                chars += len(delta)
            if chars >= service._read_cap(SOURCE):
                failure = "read_cap"
                break
            if now - started > service.REQUEST_TIMEOUT_SECONDS:
                failure = "timeout"
                break
    except Exception as exc:
        # SDK timeout classes differ by provider; never emit exception text.
        error_type = type(exc).__name__
        failure = "timeout" if isinstance(exc, TimeoutError) or "timeout" in error_type.lower() else "provider_error"
    finally:
        if stream is not None:
            try:
                stream.close()
            except Exception as exc:
                if failure is None:
                    failure, error_type = "close_error", type(exc).__name__
    elapsed = time.monotonic() - started
    raw = "".join(parts)
    output = service._strip_wrapper_fence(
        service._strip_envelope(service._strip_wrapper_fence(raw), nonce)
    ).strip()
    visible_tokens = service.provider_tokens(model, output)
    streamed_tokens = service.provider_tokens(model, raw[len(first_piece):])
    duration = last - first if first is not None and last is not None else 0
    reason = getattr(stream, "termination_reason", None)
    known = service._known_termination_reason(model.provider, reason)
    transport_complete = failure is None and service._completed_termination_reason(model.provider, reason)
    if failure:
        classification = failure
    elif not known:
        classification = "unknown_termination"
    elif service._hit_output_token_limit(model.provider, reason):
        classification = "output_cap"
    elif reason in {"refusal", "content_filter"}:
        classification = "refused"
    elif not transport_complete:
        classification = "non_completing_termination"
    elif not output:
        classification = "empty_output"
    elif service._envelope_unclosed(output, nonce) or service._residual_envelope(output, SOURCE):
        classification = "invalid_envelope"
    elif len(parts) < 2 or duration <= 0:
        classification = "single_delta"
    elif output == SOURCE.strip():
        classification = "source_echo"
    else:
        try:
            service._require_target_script([output], language)
        except service.TranslationFailed:
            classification = "wrong_script"
        else:
            classification = "eligible_pending_quality_review"
    eligible = classification == "eligible_pending_quality_review"
    usage = getattr(stream, "usage", None)
    return {
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "provider": model.provider, "model": model.model,
        "provider_model_id": getattr(model, "provider_model_id", ""),
        "language": language, "source_tokens": source_tokens,
        "translated_output_tokens": visible_tokens,
        "output_expansion": visible_tokens / source_tokens if source_tokens else None,
        "raw_output_tokens": service.provider_tokens(model, raw),
        "raw_delta_count": len(parts), "raw_characters": chars,
        "token_count_basis": "shipping provider_tokens (approximate for unmapped models)",
        "provider_output_tokens": usage.output_tokens if usage else None,
        "provider_reasoning_tokens": usage.reasoning_tokens if usage else None,
        "raw_ttft_seconds": first - started if first is not None else None,
        "raw_stream_seconds": duration,
        "sustained_raw_tokens_per_second": streamed_tokens / duration if duration > 0 else None,
        "elapsed_seconds": elapsed, "output_cap": cap,
        "termination_reason": reason if known else None,
        "transport_complete": transport_complete,
        "status": "failed" if failure else "measured",
        "classification": classification, "error_type": error_type,
        "calibration_eligible": eligible,
        "quality_review": "required" if eligible else "not_eligible",
    }


class Command(BaseCommand):
    help = "Measure configured translation models with paid real-provider calls (manual only)."

    def add_arguments(self, parser):
        parser.add_argument("--run-paid", action="store_true", help="Explicitly authorize paid calls")
        parser.add_argument("--model", action="append", help="Configured provider:model; repeat to select")
        parser.add_argument("--language", action="append", choices=LANGUAGES,
                            help="Repeat to select; default starts with Lao and Amharic")

    def handle(self, *args, **options):
        if not options["run_paid"]:
            raise CommandError("Pass --run-paid to make bounded, paid provider calls.")
        preferences = service.model_preference()
        selected = options["model"] or preferences
        if any(entry not in preferences for entry in selected):
            raise CommandError("Each --model must appear in ZPAGE_TRANSLATION_MODELS.")
        languages = options["language"] or LANGUAGES
        if len(selected) != len(set(selected)) or len(languages) != len(set(languages)):
            raise CommandError("Duplicate models or languages are not allowed.")
        records = []
        required_models = []
        for entry in preferences:
            provider, sep, name = entry.partition(":")
            provider, name = provider.strip(), name.strip()
            model = AIModel.objects.filter(provider=provider, model=name).first() if sep and provider and name else None
            if policy_disabled_reason(provider):
                exclusion = "policy_disabled"
            elif not sep or not provider or not name:
                exclusion = "invalid_preference"
            elif model is None:
                exclusion = "missing_catalogue_row"
            elif not model.is_enabled:
                exclusion = "model_disabled"
            else:
                exclusion = None
                required_models.append(entry)
            for language in languages:
                if exclusion:
                    record = {"status": "excluded", "classification": exclusion,
                              "calibration_eligible": False, "required": False}
                elif entry not in selected:
                    record = {"status": "not_selected", "classification": "not_selected",
                              "calibration_eligible": False, "required": True}
                elif not provider_is_configured(provider):
                    record = {"status": "unavailable", "classification": "missing_credentials",
                              "calibration_eligible": False, "required": True}
                elif not service.is_callable_model(model):
                    record = {"status": "unavailable", "classification": "client_unavailable",
                              "calibration_eligible": False, "required": True}
                else:
                    try:
                        record = measure(model, language)
                    except Exception as exc:
                        # Failures before streaming starts still get a matrix entry.
                        record = {"status": "failed", "classification": "setup_error",
                                  "error_type": type(exc).__name__, "calibration_eligible": False}
                    record["required"] = True
                record.update({"model_preference": entry, "language": language})
                records.append(record)
                self.stdout.write(json.dumps(record, ensure_ascii=False))
        def pairs(predicate):
            return [{"model": r["model_preference"], "language": r["language"]}
                    for r in records if predicate(r)]
        full_requested = set(required_models).issubset(selected) and set(languages) == set(LANGUAGES)
        required = [r for r in records if r["required"]]
        complete = bool(required_models) and full_requested and all(r["calibration_eligible"] for r in required)
        summary = {"type": "summary", "configured_models": preferences,
                   "required_models": required_models,
                   "selected_models": selected, "selected_languages": list(languages),
                   "required_languages": list(LANGUAGES), "full_matrix_requested": full_requested,
                   "requested_pairs": pairs(lambda r: r["model_preference"] in selected),
                   "required_pairs": pairs(lambda r: r["required"]),
                   "excluded_pairs": pairs(lambda r: r["status"] == "excluded"),
                   "not_selected_pairs": pairs(lambda r: r["status"] == "not_selected"),
                   "measured_pairs": pairs(lambda r: r["status"] == "measured"),
                   "failed_pairs": pairs(lambda r: r["status"] == "failed"),
                   "unavailable_pairs": pairs(lambda r: r["status"] == "unavailable"),
                   "ineligible_pairs": pairs(lambda r: r["required"] and not r["calibration_eligible"]),
                   "matrix_complete_pending_quality_review": complete}
        self.stdout.write(json.dumps(summary, ensure_ascii=False))
        if not complete:
            raise CommandError("Measurement matrix is incomplete; see JSON summary.")
