import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing source marker: ${start}`);
  assert.ok(to > from, `missing source marker: ${end}`);
  return source.slice(from, to);
}

test("awaited raw login helpers cannot publish the global token", () => {
  const api = readFileSync(new URL("../src/lib/api/free2z.ts", import.meta.url), "utf8");
  const transport = readFileSync(new URL("../src/lib/api/http.ts", import.meta.url), "utf8");
  const rawHelpers = [
    between(api, "  async login(", "  /** Whether the currently-authenticated"),
    between(api, "  async completeOtp(", "  async me("),
    between(api, "  async zcashLogin(", "  /** Ask the backend"),
    between(api, "  async completeSocialOAuth(", "};\n\n// ─── Profile"),
    between(transport, "export async function basicLogin(", "function safeJson("),
  ];

  for (const helper of rawHelpers) {
    assert.doesNotMatch(helper, /\bsetToken\s*\(/);
    assert.doesNotMatch(helper, /localStorage\s*\./);
  }
});

test("uncommitted profile probes use a private explicit token header", () => {
  const transport = readFileSync(new URL("../src/lib/api/http.ts", import.meta.url), "utf8");
  const requestBody = between(
    transport,
    "export async function request<T>(",
    "/** Knox login:",
  );

  assert.match(requestBody, /opts\.authToken \?\? getToken\(\)/);
  assert.match(requestBody, /headers\["Authorization"\] = `Token \$\{token\}`/);
});
