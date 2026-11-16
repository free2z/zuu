// Optional fast native predicate + mutation probe. Full Tauri IPC tests in
// src-tauri/tests/http_scope.rs are still required; this is not a device test.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const app = fileURLToPath(new URL("../", import.meta.url));
const channel = readFileSync(resolve(app, "../../rust-toolchain.toml"), "utf8").match(/channel\s*=\s*"([^"]+)"/)[1];
const rustc = ["run", channel, "rustc"];
const source = readFileSync(resolve(app, "src-tauri/src/purchase_policy.rs"), "utf8");
const policy = JSON.parse(readFileSync(resolve(app, "src/lib/purchases/policy.json"), "utf8"));
const directory = mkdtempSync(resolve(tmpdir(), "free2z-1326-native-policy-"));
function probe(rules, implementation) {
  writeFileSync(resolve(directory, "purchase_rules.rs"), `const PURCHASE_RULES: &[(&str, &str, &str, &[&str])] = &[${rules.map(r => `(${JSON.stringify(r.prefix)}, ${JSON.stringify(r.suffix ?? "")}, ${JSON.stringify(r.contains ?? "")}, &${JSON.stringify(r.methods)})`).join(",")}];`);
  writeFileSync(resolve(directory, "policy.rs"), implementation);
  writeFileSync(resolve(directory, "test.rs"), `mod policy;
#[test] fn direct_and_replayed_writes() {
  for (path, method) in [
    ("/api/stripe/create-checkout-session/", "POST"),
    ("/api/pricing/quote/", "GET"),
    ("/api/tuzis/subscribe-confirmed/alice", "POST"),
    ("/api/tuzis/donate-idempotent/alice", "POST"),
    ("/api/openai/prompt", "POST"),
    ("/api/ai/conversations/x/promptresponses/", "POST"),
    ("/api/comments/x/vote/", "POST"),
    ("/api/e2ee/chat-requests/alice/", "POST"),
    ("/api/dyte/alice/ppv", "POST"),
    ("/api/ai/prompt/", "POST"),
    ("/api/zpage/fund/", "POST"),
    ("/api/zpage/x/variants/fr/translate/quote/", "GET"),
    ("/api/zpage/x/translations/", "POST"),
    ("/api/sdk/v1/purchases", "POST"),
    ("/api/economy/usage-purchases/", "POST"),
    ("/api/mcp", "POST"),
    ("/v1/chat", "POST"), ("/v1/chat/estimate", "POST"),
    ("/api/%74uzis/subscribe/alice", "POST"),
    ("/api//tuzis/subscribe/alice", "POST"),
  ] { assert!(policy::blocked_request(path, method), "{path}"); }
}
#[test] fn receipts_and_existing_authority_stay_distinct() {
  for (path, method) in [
    ("/api/stripe/native-return/claim/", "POST"),
    ("/api/stripe/native-return/status/", "POST"),
    ("/api/stripe/transactions/", "GET"),
    ("/api/tuzis/subscribe/alice", "DELETE"),
    ("/api/tuzis/subscription-status/alice", "GET"),
    ("/api/dyte/alice/subscribers-only", "POST"),
    ("/api/tuzis/subscribe-recovery/1", "POST"),
    ("/api/sdk/v1/purchases/receipt-id", "GET"),
    ("/api/zpage/x/translations/", "GET"),
    ("/api/zpage/", "POST"),
  ] { assert!(!policy::blocked_request(path, method), "{path}"); }
  assert!(!policy::blocked_external("https", "free2z.com", "/bridge/zuuli/"));
  assert!(!policy::blocked_external("https", "free2z.com", "/bridge/e2e2z/chat/"));
  assert!(policy::blocked_external("https", "checkout.stripe.com", "/c/pay"));
  assert!(policy::blocked_external("https", "stage.free2z.cash", "/login"));
}`);
  execFileSync("rustup", [...rustc, "--edition=2021", "--test", resolve(directory, "test.rs"), "-o", resolve(directory, "probe")], { env: { ...process.env, OUT_DIR: directory }, stdio: "pipe" });
  return spawnSync(resolve(directory, "probe"), { encoding: "utf8" });
}
try {
  const baseline = probe(policy.rules, source);
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  console.log(baseline.stdout.trim());
  const noQuote = probe(policy.rules.filter(r => r.prefix !== "/api/pricing/quote"), source);
  assert.equal(noQuote.status, 101, "removing quote policy must fail the Rust assertions");
  assert.match(noQuote.stdout, /direct_and_replayed_writes \.\.\. FAILED/);
  const failOpen = source.replace(/(\.iter\(\)\s*)\.any\(/, "$1.all(");
  assert.notEqual(failOpen, source, "predicate mutation must change the source");
  const noRules = probe(policy.rules, failOpen);
  assert.equal(noRules.status, 101, "a fail-open predicate must fail the Rust assertions");
  assert.match(noRules.stdout, /direct_and_replayed_writes \.\.\. FAILED/);
  console.log(`Pinned Rust ${channel}: baseline passed; removed quote and fail-open predicate mutations failed as expected.`);
} finally { rmSync(directory, { recursive: true, force: true }); }
