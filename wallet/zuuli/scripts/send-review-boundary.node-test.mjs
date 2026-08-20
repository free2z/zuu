import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [
  send,
  bridge,
  types,
  nativeModels,
  nativeSend,
  nativeState,
  nativeCommands,
  nativePermissions,
  legacySend,
  legacyBridge,
  legacyTypes,
] = await Promise.all(
  [
    "src/features/wallet/Send.tsx",
    "src/lib/wallet/bridge.ts",
    "src/lib/wallet/types.ts",
    "../plugins/tauri-plugin-zcash/src/models.rs",
    "../plugins/tauri-plugin-zcash/src/wallet/send.rs",
    "../plugins/tauri-plugin-zcash/src/wallet/mod.rs",
    "../plugins/tauri-plugin-zcash/src/commands.rs",
    "../plugins/tauri-plugin-zcash/permissions/default.toml",
    "../zuuallet/src/pages/Send.tsx",
    "../zuuallet/src/lib/tauri.ts",
    "../zuuallet/src/types/index.ts",
  ].map((path) => readFile(new URL(`../${path}`, import.meta.url), "utf8")),
);

test("confirmation renders only the immutable native review", () => {
  assert.match(send, /proposal\.review\.payments/);
  assert.match(send, /proposal\.review\.fee/);
  assert.match(send, /proposal\.review\.total/);
  assert.doesNotMatch(send, /truncateAddress\(proposal\.review/);
  assert.doesNotMatch(send, /send-review-memo[\s\S]{0,160}\btruncate\b/);
  assert.doesNotMatch(send, /<Row label="To">[\s\S]{0,300}\bto\.trim\(\)/);
  assert.doesNotMatch(send, /<Row label="Memo">[\s\S]{0,300}>\s*\{memo\}/);
});

test("execution cannot regress to proposal-id-only authorization", () => {
  assert.match(
    bridge,
    /executeSend\(\s*proposalId:\s*number,\s*reviewDigest:\s*string,\s*confirmationToken:\s*string/s,
  );
  assert.match(
    bridge,
    /invoke\("execute_send",\s*\{\s*args:\s*\{\s*proposalId,\s*reviewDigest,\s*confirmationToken\s*\}/s,
  );
  assert.match(
    nativeModels,
    /pub struct ExecuteSendArgs\s*\{[\s\S]*review_digest:\s*String,[\s\S]*confirmation_token:\s*String/,
  );
  assert.doesNotMatch(
    nativeModels,
    /#\[derive\([^\]]*Debug[^\]]*\)\][\s\S]{0,120}pub struct ExecuteSendArgs/,
  );
  assert.match(
    nativeSend,
    /verify_confirmation[\s\S]*review_digest[\s\S]*confirmation_token/,
  );
  assert.doesNotMatch(send, /executeSend\(proposal\.proposalId\)/);
  assert.match(
    legacyBridge,
    /executeSend\(\s*proposalId:\s*number,\s*reviewDigest:\s*string,\s*confirmationToken:\s*string/s,
  );
  assert.match(
    legacyBridge,
    /args:\s*\{\s*proposalId,\s*reviewDigest,\s*confirmationToken\s*\}/s,
  );
  assert.doesNotMatch(legacySend, /executeSend\(proposal\.proposalId\)/);
  const executeCommand = nativeCommands.match(
    /pub\(crate\) async fn execute_send[\s\S]*?(?=\n#\[command\])/,
  )?.[0];
  assert.ok(executeCommand, "native execute command must remain inspectable");
  assert.ok(
    executeCommand.indexOf("take_send_proposal") <
      executeCommand.indexOf("ensure_active_seed_loaded"),
    "confirmation must be consumed before native seed custody is loaded",
  );
});

test("native proposal state owns review, digest, and one-use token", () => {
  assert.match(types, /review:\s*SendReview/);
  assert.match(types, /reviewDigest:\s*string/);
  assert.match(types, /confirmationToken:\s*string/);
  assert.match(nativeModels, /pub struct SendReview/);
  assert.match(nativeModels, /pub review_digest:\s*String/);
  assert.match(nativeModels, /pub confirmation_token:\s*String/);
  assert.match(
    nativeState,
    /pending_proposal:\s*Arc<Mutex<Option<send::PendingProposal>>>/,
  );
  assert.match(
    nativeSend,
    /pub struct PendingProposal\s*\{[\s\S]*review:\s*SendReview/,
  );
  assert.match(nativeSend, /confirmation_token_hash:\s*\[u8;\s*32\]/);
  assert.doesNotMatch(
    nativeSend,
    /struct PendingProposal\s*\{[^}]*confirmation_token:\s*String/,
  );
  assert.doesNotMatch(
    nativeState,
    /pending_proposal:\s*Arc<Mutex<Option<\(u32, WalletProposal\)>>>/,
  );
  assert.match(legacyTypes, /review:\s*SendReview/);
  assert.match(legacyTypes, /reviewDigest:\s*string/);
  assert.match(legacyTypes, /confirmationToken:\s*string/);
  assert.match(legacySend, /proposal\?\.review\.payments/);
  assert.match(legacySend, /proposal\.review\.fee/);
  assert.match(legacySend, /proposal\.review\.total/);
  assert.doesNotMatch(legacySend, /proposal\.(?:amount|fee|total)\b/);
  assert.doesNotMatch(legacySend, /truncateAddress\(.*review/);
});

test("every stale UI path has an exact native discard boundary", () => {
  assert.match(bridge, /discardSendProposal\(/);
  assert.match(send, /discardSendProposal/);
  assert.match(legacyBridge, /discardSendProposal\(/);
  assert.match(legacySend, /discardSendProposal/);
  assert.match(nativeSend, /pub async fn discard_send_proposal/);
  assert.match(nativeModels, /pub struct DiscardSendProposalArgs/);
  assert.match(nativePermissions, /"allow-discard-send-proposal"/);
});
