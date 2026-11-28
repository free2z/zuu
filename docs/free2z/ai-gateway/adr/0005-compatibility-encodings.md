# ADR 0005: Compatibility encodings of the unified API

Status: accepted

Compatibility endpoints translate requests into the unified chat request and
render its events in the client's grammar. Admission, model policy, hold,
provider invocation and settlement remain shared with the native API. A
compatibility endpoint must refuse unsupported input before charging; it must
not forward unknown fields to a provider. Idempotency fingerprints include
the encoding so a retry cannot replay a response in a different wire shape.

For streaming calls, the HTTP response starts at the hold. Provider failures
after that point are stream errors, avoiding status-based SDK retries of an
attempt that may already have been accepted. Completed responses are not
retained: an idempotent compatibility replay returns the call record with
`completion_not_retained` instead of invoking the provider again.
