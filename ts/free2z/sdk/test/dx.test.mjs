import test from "node:test";
import assert from "node:assert/strict";
import {
  Client,
  NativeTransport,
  SdkError,
  errorHint,
  formatMilli2z,
} from "../dist/index.js";
import { retryableRefusal } from "../dist/http.js";

const strict = {
  model: "m",
  messages: [],
  max_output_tokens: 1800n,
  max_output_tokens_strict: true,
};
const refusing = (error) =>
  new Client({ estimate: async () => Promise.reject(error) });

test("an SdkError message says what to do, and never more than the code", () => {
  const e = new SdkError("cap_exceeded");
  assert.match(e.message, /^Free2Z request failed \(cap_exceeded\): /);
  assert.match(e.message, /free2z\.cash\/account\/apps/);
  assert.equal(
    errorHint("brand_new_code"),
    "see docs/free2z/sdk/spec/errors.md",
  );
  assert.equal(new SdkError("Not A Code").code, "unknown");
});

test("retryability follows errors.md and refuses anything that may have run", () => {
  for (const code of [
    "internal",
    "provider_error",
    "provider_timeout",
    "too_many_holds",
    "unavailable",
  ])
    assert.equal(retryableRefusal(code, undefined), true, code);
  for (const code of [
    "insufficient_balance",
    "cap_exceeded",
    "invalid_request",
    "made_up",
  ])
    assert.equal(retryableRefusal(code, undefined), false, code);
  assert.equal(
    retryableRefusal("provider_timeout", { phase: "first_byte" }),
    true,
  );
  assert.equal(
    retryableRefusal("provider_error", { charged_2z: 1n, partial: true }),
    false,
  );
  assert.equal(retryableRefusal("internal", ["x"]), false);
});

test("preflight insists on a strict request", async () => {
  const client = new Client({
    estimate: async () => assert.fail("must not estimate"),
  });
  for (const [request, field] of [
    [
      { ...strict, max_output_tokens_strict: undefined },
      "max_output_tokens_strict",
    ],
    [{ ...strict, max_output_tokens: undefined }, "max_output_tokens"],
  ])
    await assert.rejects(
      client.preflight(request),
      (e) =>
        e.code === "invalid_request" &&
        e.details.field === field &&
        e.details.reason === "required",
    );
});

test("preflight turns refusals into the recovery UX to show", async () => {
  const ready = await new Client({
    estimate: async () => ({
      model: "m",
      input_tokens: 1n,
      max_output_tokens: 1800n,
      hold_2z: 3n,
    }),
  }).preflight(strict);
  assert.equal(ready.kind, "ready");
  assert.equal(ready.estimate.hold_2z, 3n);

  const topUp = await refusing(
    new SdkError("insufficient_balance", {
      status: 402,
      details: {
        reason: "max_output_tokens_strict",
        required_2z: 12n,
        available_milli_2z: 500n,
      },
    }),
  ).preflight(strict);
  assert.deepEqual(
    {
      kind: topUp.kind,
      required2z: topUp.required2z,
      availableMilli2z: topUp.availableMilli2z,
    },
    { kind: "needs_top_up", required2z: 12n, availableMilli2z: 500n },
  );

  const budget = await refusing(
    new SdkError("cap_exceeded", {
      details: {
        required_2z: 12n,
        cap_remaining_milli_2z: 0n,
        resets_at: null,
      },
    }),
  ).preflight(strict);
  assert.equal(budget.kind, "needs_budget");
  assert.equal(budget.resetsAt, null);
  assert.equal(budget.capRemainingMilli2z, 0n);

  // An older native plugin sends no details: the kind is still right.
  const bare = await refusing(new SdkError("insufficient_balance")).preflight(
    strict,
  );
  assert.equal(bare.kind, "needs_top_up");
  assert.equal("required2z" in bare, false);

  for (const error of [
    new SdkError("context_length_exceeded"),
    new SdkError("invalid_request", {
      details: {
        field: "max_output_tokens",
        reason: "max_output_tokens_strict",
      },
    }),
  ])
    assert.equal((await refusing(error).preflight(strict)).kind, "too_large");

  for (const error of [
    new SdkError("rate_limited"),
    new SdkError("invalid_request", { details: { field: "model" } }),
    // `max_output_tokens: 0` is malformed, not too large.
    new SdkError("invalid_request", {
      details: { field: "max_output_tokens", reason: "out_of_range" },
    }),
  ])
    await assert.rejects(refusing(error).preflight(strict), (e) => e === error);
});

test("native refusal details arrive with bigint amounts, like the web transport", async () => {
  const client = new Client(
    new NativeTransport({
      estimate: async () =>
        Promise.reject({
          code: "insufficient_balance",
          retryable: false,
          status: 402,
          details: {
            reason: "max_output_tokens_strict",
            required_2z: "12",
            available_milli_2z: "500",
            limit: "4",
          },
        }),
    }),
  );
  const result = await client.preflight(strict);
  assert.equal(result.kind, "needs_top_up");
  assert.equal(result.required2z, 12n);
  assert.equal(result.availableMilli2z, 500n);
  assert.equal(result.error.details.reason, "max_output_tokens_strict");
  assert.equal(result.error.details.limit, 4n);
});

test("native purchase-pack details are bigint, so a pack can be re-sent as quantity2z", async () => {
  const client = new Client(
    new NativeTransport({
      createPurchase: async () =>
        Promise.reject({
          code: "invalid_quantity",
          retryable: false,
          status: 400,
          details: { min_2z: "100", max_2z: "10000", packs: ["100", "500"] },
        }),
    }),
  );
  await assert.rejects(
    client.createPurchase(
      { rail: "card", quantity2z: 7n },
      { idempotencyKey: "k-1" },
    ),
    (e) =>
      e.code === "invalid_quantity" &&
      e.details.packs[1] === 500n &&
      e.details.min_2z === 100n,
  );
});

test("formatMilli2z is exact display text", () => {
  assert.equal(formatMilli2z(41_500n), "41.500");
  assert.equal(formatMilli2z(7n), "0.007");
  assert.equal(formatMilli2z(0n), "0.000");
  assert.equal(formatMilli2z(-1_250n), "-1.250");
  assert.equal(formatMilli2z(18446744073709551615n), "18446744073709551.615");
});
