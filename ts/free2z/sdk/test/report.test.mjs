import test from "node:test";
import assert from "node:assert/strict";
import { Client, FetchTransport, NativeTransport } from "../dist/index.js";
import { issuer } from "./issuer.mjs";
const CALL = "019a2f1c-9c7b-7e21-8a3d-4b5e6f7a8b9c";
const receipt = (reason, extra = {}) => ({
  report_id: "0199c0de-0000-7000-8000-000000000001",
  call_id: CALL,
  reason,
  created_at: "2026-10-14T12:00:00Z",
  ...extra,
});
test("web reportCall posts the reason to the call's report path and reads 201 and 200", async () => {
  const mock = issuer(),
    client = new Client(new FetchTransport(mock.config));
  await client.signIn();
  const seen = [];
  let status = 201;
  mock.api = (path, init) => {
    seen.push({
      path,
      method: init.method,
      auth: new Headers(init.headers).get("authorization"),
      body: JSON.parse(init.body),
    });
    return mock.json(
      receipt(JSON.parse(init.body).reason, { future: 1 }),
      status,
    );
  };
  const first = await client.reportCall(CALL, "incorrect", "wrong_grade");
  assert.deepEqual(first, receipt("incorrect"));
  status = 200;
  assert.equal((await client.reportCall(CALL, "unsafe")).reason, "unsafe");
  assert.deepEqual(seen, [
    {
      path: `/api/sdk/v1/calls/${CALL}/report`,
      method: "POST",
      auth: "Bearer access-1",
      body: { reason: "incorrect", detail: "wrong_grade" },
    },
    {
      path: `/api/sdk/v1/calls/${CALL}/report`,
      method: "POST",
      auth: "Bearer access-1",
      body: { reason: "unsafe" },
    },
  ]);
});
test("a refused report never leaves the device; a 404 is the server's code", async () => {
  const mock = issuer(),
    client = new Client(new FetchTransport(mock.config));
  await client.signIn();
  let calls = 0;
  mock.api = () => {
    calls++;
    return new Response(
      JSON.stringify({ error: { code: "not_found", message: "no" } }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  };
  for (const [args, field] of [
    [[CALL, "spam"], "reason"],
    [[CALL, "other", ""], "detail"],
    [[CALL, "other", "two\nlines"], "detail"],
    [[CALL, "other", "\u0085"], "detail"],
    [[CALL, "other", "é".repeat(201)], "detail"],
    [["../grant", "other"], "call_id"],
  ]) {
    await assert.rejects(client.reportCall(...args), (e) => {
      assert.equal(e.code, "invalid_request");
      assert.deepEqual(e.details, { field });
      return true;
    });
  }
  assert.equal(calls, 0);
  await assert.rejects(client.reportCall(CALL, "other", "é".repeat(200)), {
    code: "not_found",
    status: 404,
  });
  assert.equal(calls, 1);
});
test("native reportCall forwards only a present detail and checks the receipt", async () => {
  const sent = [];
  const bridge = {
    reportCall: async (...args) => {
      sent.push(args);
      return receipt(args[1]);
    },
  };
  const transport = new NativeTransport(bridge);
  assert.equal((await transport.reportCall(CALL, "unsafe")).reason, "unsafe");
  await transport.reportCall(CALL, "incorrect", "wrong_grade");
  assert.deepEqual(sent, [
    [CALL, "unsafe"],
    [CALL, "incorrect", "wrong_grade"],
  ]);
  bridge.reportCall = async () => ({ ...receipt("other"), call_id: "another" });
  await assert.rejects(transport.reportCall(CALL, "other"), {
    code: "invalid_response",
  });
  await assert.rejects(new NativeTransport({}).reportCall(CALL, "other"), {
    code: "unsupported_operation",
  });
});
