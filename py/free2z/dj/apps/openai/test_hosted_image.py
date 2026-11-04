"""fal wire-contract tests; all HTTP is stubbed and never bills."""
from io import BytesIO
import json
from types import SimpleNamespace

import httpx2
import pytest
from PIL import Image

from dj.apps.openai import hosted_image


def _png(size=(12, 8)):
    output = BytesIO()
    Image.new("RGB", size, "blue").save(output, format="PNG")
    return output.getvalue()


class _StreamResponse:
    status_code = 200

    def __init__(self, data=None, *, status_code=200, headers=None):
        self.status_code = status_code
        self.headers = headers or {"content-type": "image/png"}
        self.data = data

    def iter_raw(self):
        yield self.data

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None


def _response(status_code=200, payload=None):
    content = b"" if payload is None else json.dumps(payload).encode("utf-8")
    return _StreamResponse(
        content,
        status_code=status_code,
        headers={"content-type": "application/json"},
    )


def _client(mocker, *, image=None):
    client = mocker.MagicMock()
    client.__enter__.return_value = client
    request_url = f"{hosted_image.QUEUE_URL}/requests/queue-123"
    submission = _response(payload={
        "request_id": "queue-123",
        "response_url": request_url,
        "status_url": f"{request_url}/status",
    })
    client.stream.side_effect = [
        submission,
        _response(payload={"status": "COMPLETED"}),
        _response(payload={
            "has_nsfw_concepts": [False], "images": [{"url": "https://v3b.fal.media/files/image.png"}],
            "prompt": "echo must not be stored",
            "timings": {"inference": float("nan")},
        }),
        _StreamResponse(image if image is not None else _png()),
    ]
    mocker.patch.object(hosted_image.httpx2, "Client", return_value=client)
    mocker.patch.object(hosted_image.time, "sleep")
    return client


def test_valid_configuration_passes_named_release_endpoint_and_budget(settings):
    settings.FAL_IMAGE_ENABLED = True
    settings.FAL_API_KEY = "server-side-test-key"
    settings.FAL_IMAGE_MODEL_VERSION = hosted_image.MODEL_VERSION
    settings.FAL_IMAGE_APPROVED_PRICE_USD = "0.006"
    settings.FAL_IMAGE_DAILY_BUDGET_USD = "1.00"

    assert hosted_image.estimate_price("1024x1024") == hosted_image.Decimal("0.006")
    assert hosted_image.estimate_price("1536x1024") == hosted_image.Decimal("0.006")
    assert hosted_image.configuration() == (
        hosted_image.Decimal("0.006"), hosted_image.Decimal("1.00"),
    )


@pytest.mark.parametrize(
    "name,value",
    [
        ("FAL_IMAGE_ENABLED", False),
        ("FAL_API_KEY", ""),
        ("FAL_IMAGE_MODEL_VERSION", "other-model"),
        ("FAL_IMAGE_APPROVED_PRICE_USD", "0.003"),
        ("FAL_IMAGE_DAILY_BUDGET_USD", "0.005"),
    ],
)
def test_configuration_rejects_unapproved_endpoint_or_policy(settings, name, value):
    settings.FAL_IMAGE_ENABLED = True
    settings.FAL_API_KEY = "test-key"
    settings.FAL_IMAGE_MODEL_VERSION = hosted_image.MODEL_VERSION
    settings.FAL_IMAGE_APPROVED_PRICE_USD = "0.006"
    settings.FAL_IMAGE_DAILY_BUDGET_USD = "1.00"
    setattr(settings, name, value)

    with pytest.raises(hosted_image.ImageProviderUnavailable):
        hosted_image.configuration()


def test_generate_submits_once_polls_and_attributes_tariff_estimate(settings, mocker):
    settings.FAL_API_KEY = "server-side-test-key"
    client = _client(mocker)

    result = hosted_image.generate("private prompt never logged", "1536x1024")

    assert result.image == _png()
    assert result.metadata == {
        "provider": "fal",
        "model": "fal-ai/flux/schnell",
        "model_version": "FLUX.1 [schnell]",
        "model_revision_status": "provider_serving_build_revision_not_published",
        "billed_usd": None,
        "estimated_usd": "0.006",
        "billing_source": "fal_public_per_megapixel_tariff_estimate",
        "request_id": "queue-123",
        "provider_status": "COMPLETED",
        "latency_seconds": result.metadata["latency_seconds"],
        "result_count": 1,
    }
    assert isinstance(result.metadata["latency_seconds"], float)
    assert result.metadata["latency_seconds"] >= 0
    assert json.dumps(result.metadata, allow_nan=False)
    submit_call = client.stream.call_args_list[0]
    assert submit_call.args == ("POST", hosted_image.QUEUE_URL)
    assert submit_call.kwargs["headers"] == {
        "Authorization": "Key server-side-test-key",
        "Content-Type": "application/json",
        "Accept-Encoding": "identity",
    }
    assert submit_call.kwargs["json"] == {
            "prompt": "private prompt never logged",
            "image_size": {"width": 1536, "height": 1024},
            "num_images": 1,
            "output_format": "png",
            "enable_safety_checker": True,
        }
    assert client.stream.call_args_list[1].args == (
        "GET",
        f"{hosted_image.QUEUE_URL}/requests/queue-123/status"
    )
    assert client.stream.call_args_list[2].args == (
        "GET",
        f"{hosted_image.QUEUE_URL}/requests/queue-123"
    )
    assert client.stream.call_args_list[3].args == (
        "GET", "https://v3b.fal.media/files/image.png",
    )
    for call in client.stream.call_args_list:
        assert call.kwargs["follow_redirects"] is False
        assert 0 < call.kwargs["timeout"] <= hosted_image.MAX_OPERATION_SECONDS


def test_accepted_request_callback_runs_before_queue_poll(settings, mocker):
    settings.FAL_API_KEY = "server-side-test-key"
    client = _client(mocker)
    accepted = []
    responses = list(client.stream.side_effect)

    def stream_after_persist(method, url, **kwargs):
        response = responses.pop(0)
        if method == "GET" and "queue.fal.run" in url:
            assert accepted[0]["request_id"] == "queue-123"
        return response

    client.stream.side_effect = stream_after_persist

    result = hosted_image.generate(
        "prompt", "1024x1024", on_accepted=accepted.append,
    )

    assert result.metadata["request_id"] == "queue-123"
    assert len(accepted) == 1
    assert accepted[0]["provider_status"] == "IN_QUEUE"


@pytest.mark.parametrize(
    "status_code,error_type",
    [
        (422, hosted_image.ImageProviderDefiniteFailure),
        (429, hosted_image.ImageProviderDefiniteFailure),
        (408, hosted_image.ImageProviderAmbiguousFailure),
        (409, hosted_image.ImageProviderAmbiguousFailure),
        (503, hosted_image.ImageProviderAmbiguousFailure),
    ],
)
def test_submit_status_classification_does_not_retry(settings, mocker, status_code, error_type):
    settings.FAL_API_KEY = "test-key"
    client = mocker.MagicMock()
    client.__enter__.return_value = client
    client.stream.side_effect = [_response(status_code=status_code)]
    mocker.patch.object(hosted_image.httpx2, "Client", return_value=client)

    with pytest.raises(error_type):
        hosted_image.generate("prompt", "1024x1024")
    client.stream.assert_called_once()


def test_submit_timeout_is_ambiguous_and_never_retried(settings, mocker):
    settings.FAL_API_KEY = "test-key"
    client = mocker.MagicMock()
    client.__enter__.return_value = client
    client.stream.side_effect = httpx2.TimeoutException("body must not propagate")
    mocker.patch.object(hosted_image.httpx2, "Client", return_value=client)

    with pytest.raises(hosted_image.ImageProviderAmbiguousFailure) as exc:
        hosted_image.generate("private prompt", "1024x1024")
    client.stream.assert_called_once()
    assert "private prompt" not in str(exc.value)
    assert exc.value.metadata["billed_usd"] is None


def test_invalid_provider_status_is_not_copied_into_accounting_metadata(settings, mocker):
    settings.FAL_API_KEY = "test-key"
    client = _client(mocker)
    client.stream.side_effect = [
        _response(payload={
            "request_id": "queue-123",
            "response_url": f"{hosted_image.QUEUE_URL}/requests/queue-123",
            "status_url": f"{hosted_image.QUEUE_URL}/requests/queue-123/status",
        }),
        _response(payload={"status": ["COMPLETED", float("nan")]}),
    ]

    with pytest.raises(hosted_image.ImageProviderAmbiguousFailure) as exc:
        hosted_image.generate("prompt", "1024x1024")

    assert exc.value.metadata["provider_status"] == "UNKNOWN"
    assert exc.value.metadata["request_id"] == "queue-123"
    assert json.dumps(exc.value.metadata, allow_nan=False)
    assert len(client.stream.call_args_list) == 2


def test_download_failure_retains_accepted_request_and_estimate(settings, mocker):
    settings.FAL_API_KEY = "test-key"
    client = _client(mocker)
    responses = list(client.stream.side_effect)
    responses[-1] = _StreamResponse(
        status_code=302, headers={"location": "https://attacker.example"},
    )
    client.stream.side_effect = responses

    with pytest.raises(hosted_image.ImageProviderAmbiguousFailure) as exc:
        hosted_image.generate("prompt", "1024x1024")

    assert exc.value.metadata["request_id"] == "queue-123"
    assert exc.value.metadata["provider_status"] == "COMPLETED"
    assert exc.value.metadata["estimated_usd"] == "0.006"
    assert exc.value.metadata["billed_usd"] is None
    assert len(client.stream.call_args_list) == 4
    assert client.stream.call_args_list[-1].kwargs["follow_redirects"] is False


def test_invalid_output_url_is_rejected_before_download(settings, mocker):
    settings.FAL_API_KEY = "test-key"
    client = _client(mocker)
    responses = list(client.stream.side_effect)
    responses[2] = _response(payload={"has_nsfw_concepts": [False], "images": [{"url": "https://attacker.example/file.png"}]})
    client.stream.side_effect = responses

    with pytest.raises(hosted_image.ImageProviderAmbiguousFailure):
        hosted_image.generate("prompt", "1024x1024")
    assert len(client.stream.call_args_list) == 3
    assert all("fal.media" not in str(call.args) for call in client.stream.call_args_list)


def test_non_object_result_payload_retains_accepted_request(settings, mocker):
    settings.FAL_API_KEY = "test-key"
    client = _client(mocker)
    responses = list(client.stream.side_effect)
    responses[2] = _response(payload=None)
    client.stream.side_effect = responses

    with pytest.raises(hosted_image.ImageProviderAmbiguousFailure) as exc:
        hosted_image.generate("prompt", "1024x1024")

    assert exc.value.metadata["request_id"] == "queue-123"
    assert exc.value.metadata["provider_status"] == "COMPLETED"
    assert exc.value.metadata["estimated_usd"] == "0.006"
    assert all("fal.media" not in str(call.args) for call in client.stream.call_args_list)


def test_output_url_without_hostname_retains_accepted_request(settings, mocker):
    settings.FAL_API_KEY = "test-key"
    client = _client(mocker)
    responses = list(client.stream.side_effect)
    responses[2] = _response(payload={"has_nsfw_concepts": [False], "images": [{"url": "https:///missing-host.png"}]})
    client.stream.side_effect = responses

    with pytest.raises(hosted_image.ImageProviderAmbiguousFailure) as exc:
        hosted_image.generate("prompt", "1024x1024")

    assert exc.value.metadata["request_id"] == "queue-123"
    assert exc.value.metadata["provider_status"] == "COMPLETED"
    assert exc.value.metadata["estimated_usd"] == "0.006"
    assert len(client.stream.call_args_list) == 3
    assert all("fal.media" not in str(call.args) for call in client.stream.call_args_list)


def test_queue_urls_must_remain_on_fal_queue_host(settings, mocker):
    settings.FAL_API_KEY = "test-key"
    client = _client(mocker)
    responses = list(client.stream.side_effect)
    responses[0] = _response(payload={
        "request_id": "queue-123",
        "response_url": "https://queue.fal.run/fal-ai/flux/schnell/requests/queue-123",
        "status_url": "https://attacker.example/fal-ai/flux/schnell/requests/queue-123/status",
    })
    client.stream.side_effect = responses

    with pytest.raises(hosted_image.ImageProviderAmbiguousFailure) as exc:
        hosted_image.generate("prompt", "1024x1024")

    assert exc.value.metadata["request_id"] == "queue-123"
    assert exc.value.metadata["provider_status"] == "IN_QUEUE"
    assert len(client.stream.call_args_list) == 1


def test_queue_result_url_accepts_documented_response_suffix(settings, mocker):
    settings.FAL_API_KEY = "test-key"
    client = _client(mocker)
    responses = list(client.stream.side_effect)
    responses[0] = _response(payload={
        "request_id": "queue-123",
        "response_url": f"{hosted_image.QUEUE_URL}/requests/queue-123/response",
        "status_url": f"{hosted_image.QUEUE_URL}/requests/queue-123/status",
    })
    client.stream.side_effect = responses

    result = hosted_image.generate("prompt", "1024x1024")

    assert result.metadata["request_id"] == "queue-123"
    assert client.stream.call_args_list[2].args == (
        "GET", f"{hosted_image.QUEUE_URL}/requests/queue-123/response",
    )


def test_bounded_json_request_checks_deadline_between_raw_chunks(mocker):
    response = _StreamResponse(b"", headers={"content-type": "application/json"})
    response.iter_raw = lambda: iter([b'{"status":', b'"COMPLETED"}'])
    client = SimpleNamespace(stream=lambda *args, **kwargs: response)
    mocker.patch.object(hosted_image.time, "monotonic", side_effect=[0, 0.5, 1])

    with pytest.raises(httpx2.TimeoutException):
        hosted_image._bounded_json_request(
            client, "GET", "https://queue.fal.run/status", deadline=1,
        )


def test_bounded_download_rejects_oversized_bytes_and_pixel_dimensions():
    too_large = _StreamResponse(
        None, headers={"content-type": "image/png", "content-length": str(hosted_image.MAX_IMAGE_BYTES + 1)},
    )
    with pytest.raises(hosted_image.InvalidProviderImage):
        hosted_image._bounded_download(
            SimpleNamespace(stream=lambda *a, **k: too_large),
            "https://fal.media/a", hosted_image.time.monotonic() + 10,
        )

    oversized_pixels = _StreamResponse(_png((2001, 2000)))
    with pytest.raises(hosted_image.InvalidProviderImage):
        hosted_image._bounded_download(
            SimpleNamespace(stream=lambda *a, **k: oversized_pixels),
            "https://fal.media/a", hosted_image.time.monotonic() + 10,
        )


def test_bounded_download_rejects_stream_over_byte_limit():
    response = _StreamResponse(b"x" * (hosted_image.MAX_IMAGE_BYTES + 1))
    with pytest.raises(hosted_image.InvalidProviderImage):
        hosted_image._bounded_download(
            SimpleNamespace(stream=lambda *a, **k: response),
            "https://fal.media/a", hosted_image.time.monotonic() + 10,
        )


def test_bounded_download_stops_a_slow_drip_at_the_total_deadline(mocker):
    response = _StreamResponse(_png())
    response.iter_raw = lambda: iter([b"slow", b"drip"])
    client = SimpleNamespace(stream=lambda *a, **k: response)
    mocker.patch.object(hosted_image.time, "monotonic", side_effect=[0, 0.5, 1])

    with pytest.raises(httpx2.TimeoutException):
        hosted_image._bounded_download(client, "https://fal.media/a", deadline=1)


@pytest.mark.parametrize("verdict", [None, [], [False, False], [0], ["false"], False, {}])
def test_invalid_or_missing_moderation_verdict_never_downloads(mocker, verdict):
    client = _client(mocker)
    responses = list(client.stream.side_effect)
    payload = {"images": [{"url": "https://v3b.fal.media/files/image.png"}]}
    if verdict is not None:
        payload["has_nsfw_concepts"] = verdict
    responses[2] = _response(payload=payload)
    client.stream.side_effect = responses
    with pytest.raises(hosted_image.ImageProviderAmbiguousFailure):
        hosted_image.generate("private prompt", "1024x1024")
    assert client.stream.call_count == 3
