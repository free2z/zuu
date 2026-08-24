import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function rustCodeOnly(source) {
  let output = "";
  let state = "code";
  let blockDepth = 0;
  let rawTerminator = "";

  const charLiteralLength = (offset) => {
    if (source[offset] !== "'") return 0;
    let cursor = offset + 1;
    if (source[cursor] === "\\") {
      cursor += 1;
      if (source[cursor] === "u" && source[cursor + 1] === "{") {
        const close = source.indexOf("}", cursor + 2);
        if (close < 0) return 0;
        cursor = close + 1;
      } else if (source[cursor] === "x") {
        cursor += 3;
      } else {
        cursor += 1;
      }
    } else {
      cursor += 1;
    }
    return source[cursor] === "'" ? cursor - offset + 1 : 0;
  };

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];

    if (state === "line-comment") {
      output += current === "\n" ? "\n" : " ";
      if (current === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (current === "/" && next === "*") {
        blockDepth += 1;
        output += "  ";
        index += 1;
      } else if (current === "*" && next === "/") {
        blockDepth -= 1;
        output += "  ";
        index += 1;
        if (blockDepth === 0) state = "code";
      } else {
        output += current === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (state === "string") {
      output += current === "\n" ? "\n" : " ";
      if (current === "\\" && next !== undefined) {
        output += next === "\n" ? "\n" : " ";
        index += 1;
      } else if (current === '"') {
        state = "code";
      }
      continue;
    }
    if (state === "raw-string") {
      if (source.startsWith(rawTerminator, index)) {
        output += " ".repeat(rawTerminator.length);
        index += rawTerminator.length - 1;
        state = "code";
      } else {
        output += current === "\n" ? "\n" : " ";
      }
      continue;
    }

    const charLength = charLiteralLength(index);
    const rawStart = source
      .slice(index)
      .match(/^(?:br|cr|r)(#{0,255})"/);
    if (charLength > 0) {
      output += " ".repeat(charLength);
      index += charLength - 1;
    } else if (rawStart) {
      rawTerminator = `"${rawStart[1]}`;
      output += " ".repeat(rawStart[0].length);
      index += rawStart[0].length - 1;
      state = "raw-string";
    } else if (current === "/" && next === "/") {
      output += "  ";
      index += 1;
      state = "line-comment";
    } else if (current === "/" && next === "*") {
      output += "  ";
      index += 1;
      blockDepth = 1;
      state = "block-comment";
    } else if (current === '"') {
      output += " ";
      state = "string";
    } else {
      output += current;
    }
  }

  return output;
}

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

test("Rust routing scan ignores comments and literals without hiding live code", () => {
  const route = "propose_fixed_native_send(";
  const hidden = [
    ["line comment", `// ${route}\nlet live = true;`],
    ["block comment", `/* ${route} */ let live = true;`],
    ["nested block comment", `/* outer /* nested */ ${route} */ let live = true;`],
    ["normal string", `let marker = "${route}";`],
    ["byte string", `let marker = b"${route}";`],
    ["escaped quote in string", String.raw`let marker = "escaped \" ${route}";`],
    ["raw string with an embedded quote", `let marker = r#"embedded " ${route}"#;`],
    ["byte raw string", `let marker = br##"embedded "# ${route}"##;`],
  ];
  for (const [name, source] of hidden) {
    assert.equal(
      rustCodeOnly(source).includes(route),
      false,
      `${name} cannot forge a native proposal route`,
    );
  }

  const visible = [
    ["ordinary code", `${route});`],
    ["line comment termination", `// noise\n${route});`],
    ["block comment termination", `/* noise */ ${route});`],
    ["raw string termination", `let noise = r#"embedded " quote"#; ${route});`],
    ["comment markers inside a string", `let noise = "// /*"; ${route});`],
    ["double quote character literal", `let quote = b'"'; ${route});`],
    ["apostrophe character literal", String.raw`let quote = '\''; ${route});`],
    ["lifetime", `fn borrow<'a>(value: &'a str) { ${route}); }`],
  ];
  for (const [name, source] of visible) {
    assert.equal(
      rustCodeOnly(source).includes(route),
      true,
      `${name} must leave a real native proposal route visible`,
    );
  }
});

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
  assert.match(nativeSend, /issued_at_wall:\s*SystemTime/);
  assert.match(nativeSend, /expires_at_monotonic:\s*Instant/);
  assert.match(nativeSend, /expires_at_wall:\s*SystemTime/);
  assert.match(nativeSend, /now\.monotonic\s*>=\s*execution\.expires_at_monotonic/);
  assert.match(nativeSend, /now\.wall\s*>=\s*execution\.expires_at_wall/);
  assert.match(nativeSend, /now\.wall\s*<\s*execution\.issued_at_wall/);
  assert.match(nativeSend, /SEND_CONFIRMATION_TTL/);
  assert.match(nativeSend, /confirmation_rejects_either_expiry_clock_and_wall_rollback/);
  assert.match(nativeSend, /is_unicode_format_control/);
  assert.match(nativeSend, /matches!\(character, '\\u\{2028\}' \| '\\u\{2029\}'\)/);
  assert.match(nativeSend, /native_memo_renderer_escapes_every_reviewed_format_control_class/);
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

test("ZIP-321 parsing is single-payment and bound to native network authority", () => {
  const nativeSendCode = rustCodeOnly(nativeSend);
  const parseCommand = nativeCommands.match(
    /pub\(crate\) async fn parse_payment_uri[\s\S]*?(?=\n\/\/\/|\n#\[command\])/,
  )?.[0];
  assert.ok(parseCommand, "native payment-URI command must remain inspectable");
  assert.match(parseCommand, /app\.zcash\(\)/);
  assert.match(
    parseCommand,
    /parse_payment_uri\(&zcash\.state\.network,\s*&args\.uri\)/,
  );
  assert.doesNotMatch(parseCommand, /payments\.iter\(\)\.next/);
  assert.match(nativeSend, /request\.payments\(\)\.len\(\)\s*!=\s*1/);
  assert.match(nativeSend, /validate_parsed_recipient\(network,/);
  assert.match(nativeSend, /Unified address contains no receiver supported by this wallet/);
  assert.match(nativeSend, /zip321_requires_exactly_one_payment/);
  assert.match(nativeSend, /zip321_recipient_is_bound_to_the_active_network/);
  assert.match(nativeSend, /unified_address_requires_a_receiver_this_wallet_can_pay/);
  for (const [functionName, nativeProposalBoundary] of [
    ["propose_send", "propose_fixed_native_send("],
    ["propose_send_all", "propose_send_all_native_attempt("],
  ]) {
    const proposalFunction = nativeSendCode.match(
      new RegExp(`pub async fn ${functionName}\\([\\s\\S]*?(?=\\npub async fn )`),
    )?.[0];
    assert.ok(proposalFunction, `${functionName} must remain inspectable`);
    const validationIndex = proposalFunction.indexOf("parse_recipient(&state.network");
    const proposalIndex = proposalFunction.indexOf(nativeProposalBoundary);
    assert.notEqual(validationIndex, -1, `${functionName} must validate its recipient`);
    assert.notEqual(proposalIndex, -1, `${functionName} must build a native proposal`);
    for (const lowerLevelBoundary of [
      "propose_native_send_with_policy(",
      "propose_native_send(",
      "propose_transfer::<",
    ]) {
      assert.equal(
        proposalFunction.indexOf(lowerLevelBoundary),
        -1,
        `${functionName} must not bypass its dedicated native proposal boundary`,
      );
    }
    assert.ok(
      validationIndex < proposalIndex,
      `${functionName} must reject incompatible recipients before native proposal`,
    );
  }
});
