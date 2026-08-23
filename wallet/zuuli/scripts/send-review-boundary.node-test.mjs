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
  mobileCapability,
  zuuliNative,
  legacyNative,
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
    "src-tauri/capabilities/mobile.json",
    "src-tauri/src/lib.rs",
    "../zuuallet/src-tauri/src/lib.rs",
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

test("execution cannot regress to proposal-id-only or proposal-token authorization", () => {
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
    /verify_execution[\s\S]*review_digest[\s\S]*confirmation_token/,
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

test("native confirmation is a distinct OS-gated transition before execution", () => {
  for (const consumerBridge of [bridge, legacyBridge]) {
    assert.match(
      consumerBridge,
      /confirmSend\(\s*proposalId:\s*number,\s*reviewDigest:\s*string,\s*proposalToken:\s*string/s,
    );
    assert.match(
      consumerBridge,
      /args:\s*\{\s*proposalId,\s*reviewDigest,\s*proposalToken\s*\}/s,
    );
  }
  for (const consumerSend of [send, legacySend]) {
    assert.ok(
      consumerSend.indexOf("confirmSend(") < consumerSend.indexOf("executeSend("),
      "each renderer must request native confirmation before execution",
    );
    assert.match(consumerSend, /confirmation\.confirmationToken/);
  }
  const confirmCommand = nativeCommands.match(
    /pub\(crate\) async fn confirm_send[\s\S]*?(?=\n#\[command\])/,
  )?.[0];
  assert.ok(confirmCommand, "native confirmation command must remain inspectable");
  assert.ok(
    confirmCommand.indexOf("prepare_send_confirmation") <
      confirmCommand.indexOf(".dialog()") &&
      confirmCommand.indexOf(".dialog()") <
        confirmCommand.indexOf("issue_send_confirmation"),
    "native review must validate, prompt, then mint the execution token",
  );
  assert.match(nativePermissions, /"allow-confirm-send"/);
  assert.match(zuuliNative, /plugin\(tauri_plugin_dialog::init\(\)\)/);
  assert.match(legacyNative, /plugin\(tauri_plugin_dialog::init\(\)\)/);
  assert.doesNotMatch(mobileCapability, /dialog:/);
});

test("native proposal state owns review, wallet session, expiry, and separate token hashes", () => {
  assert.match(types, /review:\s*SendReview/);
  assert.match(types, /reviewDigest:\s*string/);
  assert.match(types, /proposalToken:\s*string/);
  assert.match(types, /interface SendConfirmation[\s\S]*confirmationToken:\s*string[\s\S]*expiresAt:\s*number/);
  assert.match(nativeModels, /pub struct SendReview/);
  assert.match(nativeModels, /pub review_digest:\s*String/);
  assert.match(nativeModels, /pub proposal_token:\s*String/);
  assert.match(nativeModels, /pub confirmation_token:\s*String/);
  assert.match(
    nativeState,
    /pending_proposal:\s*Arc<Mutex<Option<send::PendingProposal>>>/,
  );
  assert.match(
    nativeSend,
    /pub struct PendingProposal\s*\{[\s\S]*review:\s*SendReview/,
  );
  assert.match(nativeState, /send_session_id:\s*\[u8;\s*32\]/);
  assert.match(nativeSend, /wallet_id:\s*String/);
  assert.match(nativeSend, /session_id:\s*\[u8;\s*32\]/);
  assert.match(nativeSend, /proposal_token_hash:\s*\[u8;\s*32\]/);
  assert.match(nativeSend, /confirmation_token_hash:\s*\[u8;\s*32\]/);
  assert.match(nativeSend, /expires_at:\s*Instant/);
  assert.match(nativeSend, /SEND_CONFIRMATION_TTL/);
  assert.match(nativeSend, /review_from_native_proposal/);
  assert.match(
    nativeSend,
    /proposed_change\(\)[\s\S]{0,180}PoolType::Shielded/,
    "the displayed shielded-change policy must be re-derived from the native proposal",
  );
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
  assert.match(legacyTypes, /proposalToken:\s*string/);
  assert.match(legacyTypes, /interface SendConfirmation[\s\S]*expiresAt:\s*number/);
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
