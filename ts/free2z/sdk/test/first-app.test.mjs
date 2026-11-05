// Docs-only consumer: use only the package's public exports, plus local fakes.
import test from "node:test";
import assert from "node:assert/strict";
import { Client, FetchTransport, NativeTransport } from "@free2z/sdk";
import { issuer } from "./issuer.mjs";

const at = "2026-10-05T00:00:00Z";
const balance = {
  available_milli_2z: "18446744073709551615",
  held_milli_2z: "0",
  balance_milli_2z: "18446744073709551615",
  debt_milli_2z: "0",
  as_of: at,
};
const grant = {
  sub: "alice",
  client_id: "client",
  account_epoch: "1",
  grant_generation: "1",
  scopes: ["ai:invoke"],
  spend_cap_2z: "500",
  cap_period: "total",
  enforced: true,
  as_of: at,
};
const models = {
  catalog_version: "1",
  models: [
    {
      id: "structured",
      capabilities: { structured_output: true },
      prices: {},
    },
  ],
};
const estimate = {
  model: "structured",
  input_tokens: "1",
  max_output_tokens: "1800",
  hold_2z: "2",
};
const receipt = {
  call_id: "call-1",
  status: "settled",
  settlement: "settled",
  charged_2z: "2",
  receipt_id: "receipt-1",
};
const hints = { loginHint: "alice + test", uiLocales: "es-MX en" };
const numeric = new Set([
  "account_epoch",
  "grant_generation",
  "catalog_version",
  "spend_cap_2z",
  "input_tokens",
  "max_output_tokens",
  "hold_2z",
  "charged_2z",
  "required_2z",
  "cap_remaining_milli_2z",
]);
// Service JSON has integer lexemes; native IPC has decimal strings.
const httpJson = (value, status = 200) =>
  new Response(
    JSON.stringify(value).replace(/"([^"\\]+)":"(\d+)"/g, (m, k, v) =>
      numeric.has(k) || k.endsWith("_milli_2z") ? `"${k}":${v}` : m,
    ),
    { status, headers: { "content-type": "application/json" } },
  );

for (const native of [false, true]) {
  test(
    `docs first app: ${native ? "native DTO" : "web mockFetch"}`,
    { timeout: 5000 },
    async () => {
      let refusal,
        mode = "complete",
        events = [],
        starts = [],
        signedIn = false;
      const session = () => ({
        signedIn,
        subject: signedIn ? "alice" : null,
        grantedScopes: signedIn ? ["ai:invoke"] : [],
        persistence: "memory_only",
        generation: "1",
      });
      const error = () => ({
        code: refusal,
        status: refusal === "insufficient_balance" ? 402 : 403,
        retryable: false,
        details: {
          reason: "max_output_tokens_strict",
          required_2z: "12",
          available_milli_2z: "500",
          cap_remaining_milli_2z: "0",
          resets_at: null,
        },
      });
      const messages = () => [
        { type: "meta", call_id: "call-1", model: "structured", hold_2z: "2" },
        { type: "delta", text: '{"title":"Halves","steps":["Cut","Compare"]}' },
        {
          type: "done",
          finish_reason: "stop",
          settlement: "settled",
          charged_2z: "2",
          receipt_id: "receipt-1",
        },
      ];
      const mock = issuer();
      // Observe the URL without bypassing ID-token verification.
      const original = mock.config.authSession.open;
      mock.config.authSession.open = () => {
        const attempt = original();
        return {
          ...attempt,
          authorize(url, ...args) {
            assert.equal(
              new URL(url).searchParams.get("login_hint"),
              hints.loginHint,
            );
            assert.equal(
              new URL(url).searchParams.get("ui_locales"),
              hints.uiLocales,
            );
            return attempt.authorize(url, ...args);
          },
        };
      };
      mock.api = (path, init) => {
        if (path.endsWith("/grant")) return httpJson(grant);
        if (path.endsWith("/balance")) return httpJson(balance);
        if (path.endsWith("/models")) return httpJson(models);
        if (path.endsWith("/estimate"))
          return refusal
            ? httpJson({ error: error() }, error().status)
            : httpJson(estimate);
        if (path.endsWith("/calls/call-1")) return httpJson(receipt);
        if (path.endsWith("/chat")) {
          starts.push({
            key: new Headers(init.headers).get("idempotency-key"),
            body: init.body,
          });
          if (mode === "replay") return httpJson(receipt);
          const wire = messages()
            .slice(0, mode === "complete" ? 3 : 2)
            .map(
              ({ type, ...data }) =>
                `event: ${type}\ndata: ${JSON.stringify(data).replace(/"(hold_2z|charged_2z)":"(\d+)"/g, '"$1":$2')}\n\n`,
            )
            .join("");
          return new Response(wire, {
            headers: { "content-type": "text/event-stream" },
          });
        }
        assert.fail(path);
      };
      const bridge = {
        session: async () => session(),
        signIn: async (options) => {
          assert.deepEqual(options, hints);
          signedIn = true;
          return session();
        },
        signOut: async () => {
          signedIn = false;
          return { revoked: true, generation: "2" };
        },
        grant: async () => grant,
        balance: async () => balance,
        models: async () => models,
        estimate: async () => {
          if (refusal) throw error();
          return estimate;
        },
        startChat: async (request, options) => {
          starts.push({
            key: options.idempotencyKey,
            body: JSON.stringify(request),
          });
          events = messages().slice(0, mode === "complete" ? 3 : 2);
          return {
            operationId: options.operationId,
            ...(mode === "replay" ? { replay: receipt } : {}),
          };
        },
        nextChat: async () => {
          if (!events.length) throw { code: "stream_interrupted" };
          return events.shift();
        },
        cancelChat: async () => {},
        call: async () => receipt,
      };
      const client = new Client(
        native ? new NativeTransport(bridge) : new FetchTransport(mock.config),
      );
      const signed = await client.signIn(hints);
      assert.equal(signed.subject, "alice");
      assert.equal(signed.persistence, "memory_only");
      assert.equal((await client.grant()).enforced, true);
      assert.equal(
        (await client.balance()).available_milli_2z,
        18446744073709551615n,
      );
      const model = (await client.models()).models.find(
        (m) => m.capabilities.structured_output,
      );
      const request = {
        model: model.id,
        messages: [
          { role: "user", content: [{ type: "text", text: "Return JSON" }] },
        ],
        max_output_tokens: 1800n,
        max_output_tokens_strict: true,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "activity",
            strict: true,
            schema: { type: "object" },
          },
        },
      };
      for (const [code, kind, status] of [
        ["insufficient_balance", "needs_top_up", 402],
        ["cap_exceeded", "needs_budget", 403],
      ]) {
        refusal = code;
        const check = await client.preflight(request);
        assert.equal(check.kind, kind);
        assert.equal(check.required2z, 12n);
        assert.equal(check.error.status, status);
        if (kind === "needs_budget") assert.equal(check.resetsAt, null);
      }
      assert.equal(starts.length, 0); // refusals did no paid work
      refusal = undefined;
      assert.equal((await client.preflight(request)).kind, "ready");
      const options = {
        operationId: "operation-1",
        idempotencyKey: "persisted-key-1",
      };
      const journal = { subject: signed.subject, request, options }; // saved before sending, memory-only fake
      let text = "",
        finish;
      const stream = await client.chat(request, options);
      for await (const event of stream) {
        if (event.type === "delta") text += event.text;
        if (event.type === "done") finish = event.finish_reason;
      }
      assert.equal(finish, "stop");
      assert.deepEqual(JSON.parse(text), {
        title: "Halves",
        steps: ["Cut", "Compare"],
      });
      assert.equal(
        (await client.waitForCall(stream.callId, { timeoutMs: 0 })).charge
          .charged2z,
        2n,
      );
      mode = "cancel";
      const cancelled = await client.chat(request, {
        ...options,
        operationId: "operation-2",
        idempotencyKey: "persisted-key-2",
      });
      await cancelled.next();
      await cancelled.cancel();
      assert.equal(
        (await client.waitForCall(cancelled.callId, { timeoutMs: 0 })).charge
          .charged2z,
        2n,
      );
      // Broken delivery is ambiguous; no automatic new-key attempt is made.
      mode = "broken";
      const broken = await client.chat(journal.request, journal.options);
      await broken.next();
      await broken.next();
      await assert.rejects(broken.next(), { code: "stream_interrupted" });
      assert.equal(starts.length, 3);
      // Explicit same-account, same-body/key recovery.
      mode = "replay";
      assert.equal((await client.session()).subject, journal.subject);
      const recovered = await client.chat(journal.request, journal.options);
      assert.equal((await recovered.next()).value.type, "replay");
      assert.equal(starts.length, 4);
      assert.deepEqual(starts[3], starts[2]);
      assert.deepEqual(starts[3], starts[0]);
      await client.signOut();
      assert.equal((await client.session()).signedIn, false);
    },
  );
}
