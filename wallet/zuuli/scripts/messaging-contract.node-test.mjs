// The messaging client compared against CLIENT-CONTRACT.md, not against itself.
//
// `src/lib/messaging/parity.test.ts` pins four artefacts to each other, and all
// four are defined in that module: it proves they agree, and a command added to
// §3 and wired nowhere passes every one of its assertions — including the count,
// which reads 46 === 46 once the document reaches 47.
//
// This reads the document and the bridge and compares sets, so contract growth
// fails here until someone wires it. It lives in scripts/ rather than src/
// because that is where this repository keeps source-scanning tests, and it
// keeps `node:fs` out of the frontend's tsconfig scope.
//
// Since 2026-08-25 it reads a third artefact: `tauri-plugin-f2zmsg`'s command
// registry. §12.3 proposed a separate `scripts/check-client-contract.mjs` for
// that comparison, and a separate file would have been a third place the set is
// written down. The document, the bridge and the plugin are now held to each
// other here, in both directions.
//
// The enrollment trio is the one asymmetry, and it is §2.2's: `f2zmsg_enroll`,
// `f2zmsg_enrollment_status` and `f2zmsg_unenroll` need the wallet seed, so they
// are app-crate commands and are deliberately absent from the plugin. The test
// asserts that absence rather than excusing it.

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const contractPath = fileURLToPath(
  new URL("../../../docs/e2ee/CLIENT-CONTRACT.md", import.meta.url),
);
const wirePath = fileURLToPath(
  new URL("../../../docs/e2ee/WIRE.md", import.meta.url),
);
const bridgePath = fileURLToPath(
  new URL("../src/lib/messaging/bridge.ts", import.meta.url),
);
const eventsPath = fileURLToPath(
  new URL("../src/lib/messaging/events.ts", import.meta.url),
);
const registryPath = fileURLToPath(
  new URL(
    "../../plugins/tauri-plugin-f2zmsg/command_registry.rs",
    import.meta.url,
  ),
);
const relayPath = fileURLToPath(
  new URL(
    "../../plugins/tauri-plugin-f2zmsg/src/relay.rs",
    import.meta.url,
  ),
);
const wireCodesPath = fileURLToPath(
  new URL(
    "../../plugins/tauri-plugin-f2zmsg/src/wire_codes.rs",
    import.meta.url,
  ),
);
const enginePath = fileURLToPath(
  new URL(
    "../../plugins/tauri-plugin-f2zmsg/src/engine.rs",
    import.meta.url,
  ),
);
const storePath = fileURLToPath(
  new URL(
    "../../plugins/tauri-plugin-f2zmsg/src/store.rs",
    import.meta.url,
  ),
);
const modelsPath = fileURLToPath(
  new URL(
    "../../plugins/tauri-plugin-f2zmsg/src/models.rs",
    import.meta.url,
  ),
);
const typesPath = fileURLToPath(
  new URL("../src/lib/messaging/types.ts", import.meta.url),
);

const contract = readFileSync(contractPath, "utf8");
const wire = readFileSync(wirePath, "utf8");
const bridge = readFileSync(bridgePath, "utf8");
const events = readFileSync(eventsPath, "utf8");
const registry = readFileSync(registryPath, "utf8");
const relay = readFileSync(relayPath, "utf8");
const wireCodes = readFileSync(wireCodesPath, "utf8");
const engine = readFileSync(enginePath, "utf8");
const store = readFileSync(storePath, "utf8");
const models = readFileSync(modelsPath, "utf8");
const types = readFileSync(typesPath, "utf8");

/// §2.2: these three need the wallet seed, so they live in
/// `wallet/zuuli/src-tauri/src/messaging.rs` and are invoked with no `plugin:`
/// prefix. The plugin must not register them.
const APP_CRATE_COMMANDS = new Set([
  "f2zmsg_enroll",
  "f2zmsg_enrollment_status",
  "f2zmsg_unenroll",
]);

/** §3's command tables are `| \`name\` | args | Returns |`. */
function declaredCommands() {
  const start = contract.indexOf("## 3. The command surface");
  const end = contract.indexOf("## 4. The TypeScript contract");
  assert.ok(start >= 0 && end > start, "§3 not found in CLIENT-CONTRACT.md");

  const names = new Set();
  for (const line of contract.slice(start, end).split("\n")) {
    const cell = /^\|\s*`([a-z][a-z_0-9]*)`\s*\|/.exec(line);
    if (cell) names.add(cell[1]);
  }
  return names;
}

/** §5.1's table is `| \`f2zmsg://name\` | payload | when |`. */
function declaredEvents() {
  const names = new Set();
  for (const line of contract.split("\n")) {
    const cell = /^\|\s*`(f2zmsg:\/\/[a-z-]+)`\s*\|/.exec(line);
    if (cell) names.add(cell[1]);
  }
  return names;
}

/** The wire names in `WIRE_COMMANDS`, which is the bridge's one population. */
function implementedCommands() {
  const block = /export const WIRE_COMMANDS = \{([\s\S]*?)\n\} as const;/.exec(
    bridge,
  );
  assert.ok(block, "WIRE_COMMANDS literal not found in bridge.ts");

  const names = new Set();
  for (const [, wire] of block[1].matchAll(/^\s*\w+:\s*"([a-z_0-9]+)",$/gm)) {
    names.add(wire);
  }
  return names;
}

function implementedEvents() {
  const block = /export const EVENTS = \{([\s\S]*?)\n\} as const;/.exec(events);
  assert.ok(block, "EVENTS literal not found in events.ts");

  const names = new Set();
  for (const [, name] of block[1].matchAll(/"(f2zmsg:\/\/[a-z-]+)":/g)) {
    names.add(name);
  }
  return names;
}

/** The idents inside `with_f2zmsg_commands!`, which is the plugin's one population. */
function registeredCommands() {
  const block = /\$callback!\s*\{([\s\S]*?)\n\s*\}/.exec(registry);
  assert.ok(block, "the command registry macro body was not found");

  const names = new Set();
  for (const [, name] of block[1].matchAll(/^\s*([a-z0-9_]+),$/gm)) {
    names.add(name);
  }
  return names;
}

function difference(left, right) {
  return [...left].filter((value) => !right.has(value)).sort();
}

// Project Rust control flow while masking comments and string literals. The
// complete shipping-caller digest therefore moves for executable edits, not
// for prose or error-text changes.
function rustCodeOnly(source) {
  const masked = (value) => value.replace(/[^\r\n]/g, " ");
  let output = "";
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index + 2);
      const boundary = end < 0 ? source.length : end;
      output += masked(source.slice(index, boundary));
      index = boundary;
      continue;
    }
    if (source.startsWith("/*", index)) {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < source.length && depth > 0) {
        if (source.startsWith("/*", cursor)) {
          depth += 1;
          cursor += 2;
        } else if (source.startsWith("*/", cursor)) {
          depth -= 1;
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      if (depth !== 0) throw new Error("unterminated Rust block comment");
      output += masked(source.slice(index, cursor));
      index = cursor;
      continue;
    }
    const prefixed = source[index] === "b" && source[index + 1] === '"';
    if (source[index] === '"' || prefixed) {
      const start = index;
      let cursor = prefixed ? index + 2 : index + 1;
      let closed = false;
      while (cursor < source.length) {
        if (source[cursor] === "\\") cursor += 2;
        else if (source[cursor] === '"') {
          cursor += 1;
          closed = true;
          break;
        } else cursor += 1;
      }
      if (!closed) throw new Error("unterminated Rust string");
      output += masked(source.slice(start, cursor));
      index = cursor;
      continue;
    }
    output += source[index];
    index += 1;
  }
  return output;
}

function normalizedRustFunction(source, name) {
  const projected = rustCodeOnly(source);
  const marker = `fn ${name}(`;
  const declaration = projected.indexOf(marker);
  if (declaration < 0 || projected.indexOf(marker, declaration + marker.length) >= 0) {
    return null;
  }
  const bodyStart = projected.indexOf("{", declaration + marker.length);
  if (bodyStart < 0) return null;
  let depth = 1;
  for (let index = bodyStart + 1; index < projected.length; index += 1) {
    if (projected[index] === "{") depth += 1;
    if (projected[index] === "}") depth -= 1;
    if (depth === 0) {
      return projected.slice(bodyStart + 1, index).replace(/\s+/g, " ").trim();
    }
  }
  return null;
}

function mutateRustFunction(source, name, mutate) {
  const projected = rustCodeOnly(source);
  const marker = `fn ${name}(`;
  const declaration = projected.indexOf(marker);
  assert.ok(declaration >= 0, `${name} mutation target was not found`);
  assert.equal(
    projected.indexOf(marker, declaration + marker.length),
    -1,
    `${name} mutation target was not unique`,
  );
  const bodyStart = projected.indexOf("{", declaration + marker.length);
  assert.ok(bodyStart >= 0, `${name} mutation body was not found`);
  let depth = 1;
  for (let index = bodyStart + 1; index < projected.length; index += 1) {
    if (projected[index] === "{") depth += 1;
    if (projected[index] === "}") depth -= 1;
    if (depth === 0) {
      const body = source.slice(bodyStart + 1, index);
      const changed = mutate(body);
      assert.notEqual(changed, body, `${name} mutation did not apply`);
      return `${source.slice(0, bodyStart + 1)}${changed}${source.slice(index)}`;
    }
  }
  assert.fail(`${name} mutation body was unterminated`);
}

const REVIEWED_BIND_CALLER_DIGESTS = {
  deliver: "3c34dded90af4e40a73341f0ccca101c8a9147e52e939c62ec76c1b111f413d5",
  send_control: "bb626950ad22adf6d76ccdf776ee0b120697d3bdf17fa46bd31a9448106dce4a",
};

const REVIEWED_BIND_HELPER_DIGESTS = {
  alarms: "cbc1e217f045ec30484a4fb75f4172f06967d01561acd8c43af3fb984d01ba08",
  acknowledge_alarm: "45679d36b649e2b4f94efe5fa410cb7a57d78d6c36304b39bae66b0dfcf7a7d5",
  append_and_confirm_binding: "616c0079ee090b81565faa6edb08a1d555e4974cc1f3be316240035df29e6a2c",
  persist_and_emit_send_address_stolen: "d354fa606aebbfd60e3c9da844c214e00916f6d0afb0966d596748ccda04157a",
  ensure_bound: "8a9e4793f8e896892fbb34d16e0d3622fdbc8ea6c63ca0305acb0a0c45de2851",
  persist_bind_state: "f9d9a95dee05a8ad5821707b315a39efb5bd7900e7492e6155214a9c7b5e9555",
  set_peer_advert: "ed9eccea11aca60298f0549e47486e46a00db816ff320bea7512eca0fe0add61",
  unenroll: "7010b1db1c2ad84340fa54fb6e068f9b6775644df6dd2cde86ab6e906009ffea",
  leave_conversation: "673121980c042560f89118c0f3e10e1e03433bf26471c4efaac6cec33fd0b376",
  mark_send_address_stolen_delivery: "3d2495c0d3ce5b117045b37cd798fe839ba9720d7c4b5d9047a0baaa8b1b2283",
  send_address_stolen_alarm: "3aca370f3dcc4321fa7ebe5ef06fdc85cea259e7d3ff99a1f745eee0d47a3b2f",
};

function relayErrorContractFailures({
  clientContract = contract,
  wireSpec = wire,
  relayRuntime = relay,
  mapperRuntime = wireCodes,
  engineRuntime = engine,
  storeRuntime = store,
  publicModels = models,
  shippingTypes = types,
} = {}) {
  const failures = [];
  const code10Rows = clientContract
    .split("\n")
    .filter((line) => /^\| 10 \| `ERR_NO_ACCESS` \|/.test(line));
  if (code10Rows.length !== 1) {
    failures.push(`CLIENT-CONTRACT code-10 rows: ${code10Rows.length}`);
  } else if (
    !code10Rows[0].includes("`relay-protocol-violation`") ||
    code10Rows[0].includes("send-unavailable")
  ) {
    failures.push("CLIENT-CONTRACT code 10 is not unconditionally a protocol violation");
  }

  for (const required of [
    "`APPEND` never returns code 10.",
    "wrong-key send side returns code 15",
    "applying code 10 to them would",
  ]) {
    if (!wireSpec.includes(required)) {
      failures.push(`WIRE send-side collapse is missing ${JSON.stringify(required)}`);
    }
  }

  for (const required of [
    "pub fn from_relay(code: WireCode, command: Command, attempt: BindAttempt)",
    "| WireCode::NoAccess",
    "fn every_command_code_and_attempt_matches_the_allowed_context_matrix()",
    "from_relay(WireCode::Unavailable, Command::Read, BindAttempt::Later)",
    "from_relay(WireCode::Quota, Command::Append, BindAttempt::Later)",
  ]) {
    if (!mapperRuntime.includes(required)) {
      failures.push(`shipping mapper is missing ${JSON.stringify(required)}`);
    }
  }
  if (mapperRuntime.includes("CommandSide")) {
    failures.push("shipping mapper still uses the too-coarse CommandSide context");
  }

  const genericCommandContexts = relayRuntime.match(/proto\(error, C::COMMAND,/g) ?? [];
  const helloContexts = relayRuntime.match(/proto\(error, Command::Hello,/g) ?? [];
  const bindCommandContexts =
    relayRuntime.match(/proto\(error, Command::BindSend, attempt\)/g) ?? [];
  if (genericCommandContexts.length !== 4) {
    failures.push(
      `relay generic response paths carrying C::COMMAND: ${genericCommandContexts.length}`,
    );
  }
  if (helloContexts.length !== 2) {
    failures.push(`relay HELLO paths carrying Command::Hello: ${helloContexts.length}`);
  }
  if (bindCommandContexts.length !== 2) {
    failures.push(
      `relay BIND paths carrying exact Command::BindSend: ${bindCommandContexts.length}`,
    );
  }
  if (relayRuntime.includes("CommandSide")) {
    failures.push("relay response paths still erase exact command context");
  }

  for (const required of [
    "durable `Fresh` → `OutcomeUnknown` write",
    "same-key `APPEND`",
    "never becomes `compromised`",
    "intercepted before this public mapper",
  ]) {
    if (!clientContract.includes(required)) {
      failures.push(`CLIENT-CONTRACT bind reconciliation is missing ${JSON.stringify(required)}`);
    }
  }
  for (const required of [
    "before sending its first bind, the client MUST durably",
    "same-key `APPEND`",
    "neither emits a public protocol",
    "ordinary later bind remains a\nclient protocol defect",
    "Only a genuinely\ndistinct replacement address enters `Fresh`",
    "local bookkeeping MUST NOT rewrite relay acceptance as failure",
  ]) {
    if (!wireSpec.includes(required)) {
      failures.push(`WIRE bind reconciliation is missing ${JSON.stringify(required)}`);
    }
  }

  const ensureBound = engineRuntime.slice(
    engineRuntime.indexOf("async fn ensure_bound"),
    engineRuntime.indexOf("fn mark_delivery"),
  );
  const preflight = ensureBound.indexOf(
    "persist_bind_state(&stored.conversation_id, BindState::OutcomeUnknown)",
  );
  const irreversibleBind = ensureBound.indexOf("connection.bind_send(");
  const durableReload = ensureBound.indexOf(
    "let current = self.conversation(&stored.conversation_id)?",
  );
  const compromisedCheck = ensureBound.indexOf("if self.send_address_is_stolen(&current)");
  const stateRead = ensureBound.indexOf("outbound.effective_bind_state()");
  if (preflight < 0 || irreversibleBind < 0 || preflight > irreversibleBind) {
    failures.push("shipping engine does not durably enter OutcomeUnknown before BIND_SEND");
  }
  if (
    durableReload < 0 ||
    compromisedCheck < durableReload ||
    stateRead < compromisedCheck
  ) {
    failures.push("shipping engine does not reject durable compromise before bind-state use");
  }
  const deliverBody = engineRuntime.slice(
    engineRuntime.indexOf("    async fn deliver("),
    engineRuntime.indexOf("    async fn ensure_bound("),
  );
  const sendControlBody = engineRuntime.slice(
    engineRuntime.indexOf("    async fn send_control("),
    engineRuntime.indexOf("/// The highest queue index"),
  );
  for (const [name, body] of [
    ["deliver", deliverBody],
    ["send_control", sendControlBody],
  ]) {
    const ensureCall = "self.ensure_bound(&current).await";
    const ensureIndex = body.indexOf(ensureCall);
    const compromiseIndex = body.indexOf("if self.send_address_is_stolen(&current)");
    const appendIndex = body.indexOf(".append_and_confirm_binding(");
    const appendCalls = body.match(/\.append_and_confirm_binding\(/g) ?? [];
    if (
      compromiseIndex < 0 ||
      ensureIndex < compromiseIndex ||
      appendIndex < ensureIndex ||
      appendCalls.length !== 1
    ) {
      failures.push(
        `${name} does not call ensure_bound then shared append reconciliation exactly once`,
      );
    }
    if (name === "deliver") {
      const statusWrites =
        body.match(/mark_send_address_stolen_delivery\(msg_id, now\)/g) ?? [];
      if (statusWrites.length !== 2) {
        failures.push(`deliver theft delivery-state follow-through calls: ${statusWrites.length}`);
      }
    }
    const normalized = normalizedRustFunction(engineRuntime, name);
    const digest =
      normalized === null
        ? "missing"
        : createHash("sha256").update(normalized).digest("hex");
    if (digest !== REVIEWED_BIND_CALLER_DIGESTS[name]) {
      failures.push(`${name} complete comment/literal-insensitive body digest: ${digest}`);
    }
  }

  for (const name of [
    "alarms",
    "acknowledge_alarm",
    "append_and_confirm_binding",
    "persist_and_emit_send_address_stolen",
    "ensure_bound",
    "persist_bind_state",
    "set_peer_advert",
    "unenroll",
    "leave_conversation",
    "mark_send_address_stolen_delivery",
    "send_address_stolen_alarm",
  ]) {
    const normalized = normalizedRustFunction(engineRuntime, name);
    const digest =
      normalized === null
        ? "missing"
        : createHash("sha256").update(normalized).digest("hex");
    if (digest !== REVIEWED_BIND_HELPER_DIGESTS[name]) {
      failures.push(`${name} complete comment/literal-insensitive body digest: ${digest}`);
    }
    if (name === "alarms") {
      if (
        !normalized?.includes("self.volatile_compromise_alarms.values()") ||
        !normalized.includes("append_alarm_once(&mut alarms, alarm)")
      ) {
        failures.push("public alarm listing omits volatile security evidence");
      }
    } else if (name === "acknowledge_alarm") {
      const commit = normalized?.indexOf(".commit(") ?? -1;
      const persistAlarm = normalized?.indexOf("records.put_alarms(&alarms)") ?? -1;
      const persistBlocker = normalized?.indexOf("records.put_conversation(stored)") ?? -1;
      const clearFallback = normalized?.search(/volatile_compromise_alarms\s*\.remove\(/) ?? -1;
      if (
        commit < 0 ||
        persistAlarm < commit ||
        persistBlocker < persistAlarm ||
        clearFallback < commit
      ) {
        failures.push("alarm acknowledgement does not atomically persist evidence/blocker before clearing fallback");
      }
    } else if (name === "append_and_confirm_binding") {
      const append = normalized?.indexOf(".append(send_key, send_addr, ciphertext)") ?? -1;
      const confirmed = normalized?.indexOf(
        "persist_bind_state(&stored.conversation_id, BindState::Confirmed)",
      ) ?? -1;
      const bestEffortConfirmation = normalized?.indexOf(
        "let Err(error) = self.persist_bind_state(",
      ) ?? -1;
      if (
        append < 0 ||
        confirmed < append ||
        bestEffortConfirmation < append
      ) {
        failures.push("same-key APPEND success must precede durable Confirmed state");
      }
    } else if (name === "persist_and_emit_send_address_stolen") {
      const commit = normalized?.indexOf(".commit(") ?? -1;
      const emit = normalized?.indexOf("self.sink.alarm(alarm)") ?? -1;
      if (commit < 0 || emit < commit) {
        failures.push("the atomic theft commit must precede alarm event emission");
      }
    } else if (name === "persist_bind_state") {
      const explicitState = normalized?.indexOf("queue.bind_state = Some(state)") ?? -1;
      const downgradeSafe = normalized?.indexOf(
        "queue.bound = state != BindState::Fresh",
      ) ?? -1;
      if (explicitState < 0 || downgradeSafe < explicitState) {
        failures.push("persisted bind state is not explicit and downgrade-safe");
      }
    } else if (name === "set_peer_advert") {
      const parsedAddress = normalized?.indexOf("queue_address(&advert.send_addr)") ?? -1;
      const identical = normalized?.indexOf("if identical") ?? -1;
      const freshSeed = normalized?.indexOf("rand::rng().fill_bytes(&mut send_key_seed)") ?? -1;
      const replacement = normalized?.indexOf("bind_state: Some(BindState::Fresh)") ?? -1;
      const commit = normalized?.indexOf(".commit(") ?? -1;
      const flushAlarm = normalized?.indexOf("records.put_alarms(&alarms)") ?? -1;
      const clearFallback = normalized?.indexOf(".volatile_compromise_alarms.remove(") ?? -1;
      if (
        parsedAddress < 0 ||
        identical < parsedAddress ||
        freshSeed < identical ||
        replacement < identical ||
        commit < replacement ||
        flushAlarm < commit ||
        clearFallback < commit
      ) {
        failures.push("advert replay/replacement key, alarm, or state is not fresh and commit-ordered");
      }
      if (normalized?.includes("queue_key(conversation_id, LABEL_QUEUE_SEND)")) {
        failures.push("distinct replacement advert reuses the deterministic initial send key");
      }
    } else if (name === "unenroll") {
      const commit = normalized?.indexOf(".commit(") ?? -1;
      const flushAlarm = normalized?.indexOf("records.put_alarms(&alarms)") ?? -1;
      const clearFallback = normalized?.indexOf("volatile_compromise_alarms.clear()") ?? -1;
      if (commit < 0 || flushAlarm < commit || clearFallback < commit) {
        failures.push("unenroll clears in-memory compromise before durable deletion/alarm flush");
      }
    } else if (name === "leave_conversation") {
      const commit = normalized?.indexOf(".commit(") ?? -1;
      const flushAlarm = normalized?.indexOf("records.put_alarms(&alarms)") ?? -1;
      const clearFallback = normalized?.indexOf(".volatile_compromise_alarms.remove(") ?? -1;
      if (commit < 0 || flushAlarm < commit || clearFallback < commit) {
        failures.push("leave_conversation clears queue compromise before durable removal/alarm flush");
      }
    } else if (name === "mark_send_address_stolen_delivery") {
      if (
        !normalized?.includes("Some(ErrorCode::SendAddressStolen)") ||
        !normalized.includes("if let Err(error) = self.mark_delivery(")
      ) {
        failures.push("delivery-state failure can mask definitive theft");
      }
    } else if (name === "send_address_stolen_alarm") {
      if (!normalized?.includes("relay_url: Some(relay_url.to_owned())")) {
        failures.push("queue theft alarm omits the relay returning AlreadyBound");
      }
    }
  }

  const productionEngine = engineRuntime.slice(0, engineRuntime.indexOf("#[cfg(test)]"));
  const freshConstructors =
    productionEngine.match(/bind_state: Some\(BindState::Fresh\)/g) ?? [];
  if (freshConstructors.length !== 2) {
    failures.push(`production Fresh outbound constructors: ${freshConstructors.length}`);
  }
  for (const name of ["join_conversation", "set_peer_advert"]) {
    const body = normalizedRustFunction(productionEngine, name);
    if (!body?.includes("bind_state: Some(BindState::Fresh)")) {
      failures.push(`${name} does not explicitly construct a Fresh outbound queue`);
    }
  }
  for (const required of [
    "BindAttempt::OutcomeUnknown",
    "BindSendOutcome::AlreadyBoundAfterUnknown",
    "async fn append_and_confirm_binding",
    ".append(send_key, send_addr, ciphertext)",
    "persist_bind_state(&stored.conversation_id, BindState::Confirmed)",
    "failed_preflight_commit_sends_no_bind",
    "dropped_applied_bind_restarts_and_same_key_append_confirms_without_alarm",
    "fresh_dropped_applied_bind_restarts_and_reconciles_without_alarm",
    "legacy_unknown_unbound_restart_binds_appends_and_confirms_without_alarm",
    "fresh_already_bound_is_still_loud_theft",
    "failed_atomic_theft_commit_uses_loud_in_memory_fallback_without_partial_state",
    "failed_delivery_status_write_never_masks_or_reopens_theft",
    "accepted_append_survives_failed_bind_confirmation_write",
    "TransportHealth::Unavailable",
    "AlarmKind::QueueSendAddressStolen",
    "TransportHealth::Compromised",
    "a stale pre-theft clone must send neither BIND_SEND nor APPEND",
    "Confirmed must be persisted only after same-key APPEND succeeds",
    "sticky retries must not emit a second alarm event",
    "unenroll_clears_in_memory_compromise_only_after_durable_commit",
    "a failed durable deletion must retain the in-memory blocker",
    "leave_clears_queue_compromise_only_after_durable_removal",
    "a failed durable removal must retain the queue blocker",
    "status-write failure must never reopen BIND_SEND or APPEND",
    "failed auxiliary confirmation must retain safe reconciliation state",
  ]) {
    if (!engineRuntime.includes(required)) {
      failures.push(`shipping bind state machine is missing ${JSON.stringify(required)}`);
    }
  }
  for (const required of [
    "#[serde(default)]\n    pub bind_state: Option<BindState>",
    "pub const fn effective_bind_state",
    "legacy_bind_records_default_conservatively_and_preserve_confirmed_truth",
    "bound: true",
  ]) {
    if (!storeRuntime.includes(required)) {
      failures.push(`durable bind schema is missing ${JSON.stringify(required)}`);
    }
  }

  for (const required of [
    "Authenticated replay of an identical queue advert",
    "genuinely distinct replacement advert installs a `Fresh`",
    "does not delete the historical,\nnon-dismissible alarm",
    "Relay acceptance remains the delivery truth",
  ]) {
    if (!clientContract.includes(required)) {
      failures.push(`CLIENT-CONTRACT queue replacement rule is missing ${JSON.stringify(required)}`);
    }
  }

  for (const required of [
    "either the local engine faulted or a relay or directory reported its own `ERR_INTERNAL`",
    "is deliberately excluded from that claim because both tables",
  ]) {
    if (!clientContract.includes(required)) {
      failures.push(`public internal attribution is missing ${JSON.stringify(required)}`);
    }
  }
  if (!mapperRuntime.includes("explicit component-internal fault")) {
    failures.push("shipping mapper does not describe component-relative internal faults");
  }
  if (!publicModels.includes("component-internal fault: either this engine failed locally")) {
    failures.push("public ErrorCode model does not describe component-relative internal faults");
  }

  for (const [name, source, required] of [
    ["CLIENT-CONTRACT Alarm", clientContract, "relayUrl: string | null;       // required for queue/relay attribution"],
    ["shipping Alarm schema", shippingTypes, "relayUrl: z.string().nullable()"],
    ["Rust Alarm model", publicModels, "#[serde(default)]\n    pub relay_url: Option<String>"],
    ["shipping theft alarm", engineRuntime, "send_address_stolen_alarm(&current.peer_handle, &outbound.relay_url)"],
    ["shipping theft alarm field", engineRuntime, "relay_url: Some(relay_url.to_owned())"],
  ]) {
    if (!source.includes(required)) {
      failures.push(`${name} is missing ${JSON.stringify(required)}`);
    }
  }

  for (const required of [
    "already bound to another or unknown key",
    "name the relay that returned the result",
    "does not identify who bound it",
  ]) {
    if (!clientContract.includes(required)) {
      failures.push(`CLIENT-CONTRACT neutral theft attribution is missing ${JSON.stringify(required)}`);
    }
  }
  for (const required of [
    "leaked, observed, or decommissioned address",
    "shown the relay that returned the result",
    "does not identify who performed that bind",
  ]) {
    if (!wireSpec.includes(required)) {
      failures.push(`WIRE neutral theft attribution is missing ${JSON.stringify(required)}`);
    }
  }
  if (!publicModels.includes("The relay is attributed;\n/// the actor who performed the bind is not.")) {
    failures.push("public transport model over-attributes a fresh AlreadyBound actor");
  }
  if (!relayRuntime.includes("The refusal identifies the relay that returned it, not who bound the")) {
    failures.push("shipping relay client over-attributes a fresh AlreadyBound actor");
  }

  for (const required of [
    "acknowledging_volatile_alarm_durably_preserves_active_queue_blocker",
    "relay_attribution_serializes_and_old_alarms_default_to_none",
    "a failed unenrollment must not partially flush volatile evidence",
    "successful removal must discard the queue-scoped blocker",
    "recovered storage installs replacement and flushes alarm",
    "assert_ne!(\n            replacement_queue.send_key_seed",
    "legacy unknown retry remained",
  ]) {
    if (!engineRuntime.includes(required) && !publicModels.includes(required)) {
      failures.push(`shipping alarm/replacement regression is missing ${JSON.stringify(required)}`);
    }
  }

  const componentSection =
    "// component-internal (local engine or peer-reported relay/directory fault)";
  for (const [name, source, startMarker, endMarker] of [
    ["CLIENT-CONTRACT ErrorCode union", clientContract, "type ErrorCode =", "```"],
    ["shipping ErrorCode schema", shippingTypes, "export const ErrorCodeSchema", "]);"],
  ]) {
    const start = source.indexOf(startMarker);
    const end = start < 0 ? -1 : source.indexOf(endMarker, start + startMarker.length);
    const block = start < 0 || end < 0 ? "" : source.slice(start, end);
    const local = block.indexOf("// local");
    const component = block.indexOf(componentSection);
    const internal = block.indexOf('"internal"');
    const componentCount = block.split(componentSection).length - 1;
    const directlyClassified =
      component >= 0 &&
      /^\s*\|?\s*"internal"\s*[,;]/.test(block.slice(component + componentSection.length));
    if (
      local < 0 ||
      component <= local ||
      internal <= component ||
      componentCount !== 1 ||
      !directlyClassified ||
      block.slice(local, component).includes('"internal"')
    ) {
      failures.push(`${name} does not classify internal as component-relative`);
    }
  }

  return failures;
}

test("the contract and the bridge are the documents this test thinks they are", () => {
  // Without these, a moved file or a renamed heading makes every comparison
  // below vacuous instead of failing.
  assert.match(contract, /# free2z E2EE — Client contract/);
  assert.ok(declaredCommands().size > 0, "no commands parsed from §3");
  assert.ok(declaredEvents().size > 0, "no events parsed from §5.1");
  assert.ok(implementedCommands().size > 0, "no commands parsed from bridge.ts");
  assert.ok(implementedEvents().size > 0, "no events parsed from events.ts");
  assert.ok(
    registeredCommands().size > 0,
    "no commands parsed from the plugin's command registry",
  );
});

test("Rust body projection ignores nested comments and literal contents", () => {
  const first = `fn fixture() {
    /* outer { /* nested } */ still outer */
    let text = "first { // not a comment"; // line comment }
    let bytes = b"first bytes }";
    do_work(text, bytes);
  }`;
  const second = `fn fixture() {
    /* replacement /* deeper { } */ prose */
    let text = "second } /* not a comment"; // different comment {
    let bytes = b"different bytes {";
    do_work(text, bytes);
  }`;
  assert.equal(normalizedRustFunction(first, "fixture"), normalizedRustFunction(second, "fixture"));
});

test("the bridge implements exactly the commands §3 declares", () => {
  const spec = declaredCommands();
  const impl = implementedCommands();

  assert.deepEqual(
    { missing: difference(spec, impl), extra: difference(impl, spec) },
    { missing: [], extra: [] },
  );
});

test("events.ts declares exactly the events §5.1 does", () => {
  const spec = declaredEvents();
  const impl = implementedEvents();

  assert.deepEqual(
    { missing: difference(spec, impl), extra: difference(impl, spec) },
    { missing: [], extra: [] },
  );
});

test("the plugin registers exactly the commands §3 declares, minus the app-crate trio", () => {
  const spec = new Set(
    [...declaredCommands()].filter((name) => !APP_CRATE_COMMANDS.has(name)),
  );
  const impl = registeredCommands();

  assert.deepEqual(
    { missing: difference(spec, impl), extra: difference(impl, spec) },
    { missing: [], extra: [] },
  );
});

test("the plugin does not register a command that needs the wallet seed", () => {
  // §2.2. If one of these ever appears in the plugin, the mnemonic has a route
  // into the webview's JavaScript heap and the whole reason enrollment lives in
  // the app crate is gone.
  const registered = registeredCommands();
  assert.deepEqual(
    [...APP_CRATE_COMMANDS].filter((name) => registered.has(name)),
    [],
  );
});

test("the bridge and the plugin agree, so neither can drift alone", () => {
  // The document is the source of truth and both are compared to it above.
  // This is the diagonal: it fails with a clearer message when only one of the
  // two moved, which is the likeliest way this breaks.
  const bridge = new Set(
    [...implementedCommands()].filter((name) => !APP_CRATE_COMMANDS.has(name)),
  );
  const plugin = registeredCommands();

  assert.deepEqual(
    { onlyInBridge: difference(bridge, plugin), onlyInPlugin: difference(plugin, bridge) },
    { onlyInBridge: [], onlyInPlugin: [] },
  );
});

test("relay error semantics stay bound across WIRE, client contract, and shipping code", () => {
  assert.deepEqual(relayErrorContractFailures(), []);
});

test("relay error binding rejects public-contract, mapper, and call-site mutations", () => {
  const contractMutation = contract.replace(
    "| 10 | `ERR_NO_ACCESS` | `relay-protocol-violation`.",
    "| 10 | `ERR_NO_ACCESS` | `send-unavailable`.",
  );
  assert.notEqual(contractMutation, contract, "contract mutation did not apply");
  assert.notDeepEqual(
    relayErrorContractFailures({ clientContract: contractMutation }),
    [],
  );

  const mapperMutation = wireCodes.replace(
    "| WireCode::NoAccess",
    "| WireCode::Quota",
  );
  assert.notEqual(mapperMutation, wireCodes, "mapper mutation did not apply");
  assert.notDeepEqual(
    relayErrorContractFailures({ mapperRuntime: mapperMutation }),
    [],
  );

  const callSiteMutation = relay.replace("proto(error, C::COMMAND,", "proto(error, Command::Read,");
  assert.notEqual(callSiteMutation, relay, "call-site mutation did not apply");
  assert.notDeepEqual(
    relayErrorContractFailures({ relayRuntime: callSiteMutation }),
    [],
  );

  const bindCallSiteMutation = relay.replace(
    "proto(error, Command::BindSend, attempt)",
    "proto(error, Command::Read, attempt)",
  );
  assert.notEqual(bindCallSiteMutation, relay, "BIND call-site mutation did not apply");
  assert.notDeepEqual(
    relayErrorContractFailures({ relayRuntime: bindCallSiteMutation }),
    [],
  );

  const bindContractMutation = contract.replace(
    "durable `Fresh` → `OutcomeUnknown` write",
    "in-memory first-attempt marker",
  );
  assert.notEqual(bindContractMutation, contract, "bind contract mutation did not apply");
  assert.notDeepEqual(
    relayErrorContractFailures({ clientContract: bindContractMutation }),
    [],
  );

  const bindWireMutation = wire.replace(
    "ordinary later bind remains a\nclient protocol defect",
    "ordinary later bind may also be reconciled",
  );
  assert.notEqual(bindWireMutation, wire, "bind WIRE mutation did not apply");
  assert.notDeepEqual(relayErrorContractFailures({ wireSpec: bindWireMutation }), []);

  const deliverCallerMutation = engine.replace(
    ".append_and_confirm_binding(",
    ".append_without_bind_reconciliation(",
  );
  assert.notEqual(deliverCallerMutation, engine, "deliver caller mutation did not apply");
  assert.notDeepEqual(
    relayErrorContractFailures({ engineRuntime: deliverCallerMutation }),
    [],
  );

  const sendControlAnchor = ".append_and_confirm_binding(";
  const sendControlIndex = engine.lastIndexOf(sendControlAnchor);
  const sendControlCallerMutation =
    sendControlIndex < 0
      ? engine
      : `${engine.slice(0, sendControlIndex)}${engine
          .slice(sendControlIndex)
          .replace(
            sendControlAnchor,
            ".append_without_bind_reconciliation(",
          )}`;
  assert.notEqual(
    sendControlCallerMutation,
    engine,
    "send_control caller mutation did not apply",
  );
  assert.notDeepEqual(
    relayErrorContractFailures({ engineRuntime: sendControlCallerMutation }),
    [],
  );

  const deliverBindAnchor = "let bind = match self.ensure_bound(&current).await {";
  const deliverEarlyReturn = engine.replace(
    deliverBindAnchor,
    `return Err(Error::internal("mutation"));\n        ${deliverBindAnchor}`,
  );
  assert.notEqual(deliverEarlyReturn, engine, "deliver early-return mutation did not apply");
  assert.notDeepEqual(
    relayErrorContractFailures({ engineRuntime: deliverEarlyReturn }),
    [],
  );

  const sendControlBindAnchor = "let bind = self.ensure_bound(&current).await?;";
  const sendControlBind = engine.lastIndexOf(sendControlBindAnchor);
  const sendControlEarlyReturn =
    sendControlBind < 0
      ? engine
      : `${engine.slice(0, sendControlBind)}return Err(Error::internal("mutation"));\n        ${engine.slice(sendControlBind)}`;
  assert.notEqual(
    sendControlEarlyReturn,
    engine,
    "send_control early-return mutation did not apply",
  );
  assert.notDeepEqual(
    relayErrorContractFailures({ engineRuntime: sendControlEarlyReturn }),
    [],
  );

  const compromiseGuard = "if self.send_address_is_stolen(&current)";
  const compromiseMutation = engine.replace(
    compromiseGuard,
    "if false && self.send_address_is_stolen(&current)",
  );
  assert.notEqual(compromiseMutation, engine, "compromise guard mutation did not apply");
  assert.notDeepEqual(
    relayErrorContractFailures({ engineRuntime: compromiseMutation }),
    [],
  );

  const ensureCompromiseIndex = engine.lastIndexOf(compromiseGuard);
  const ensureCompromiseMutation =
    ensureCompromiseIndex < 0
      ? engine
      : `${engine.slice(0, ensureCompromiseIndex)}if false && ${engine.slice(ensureCompromiseIndex + 3)}`;
  assert.notEqual(
    ensureCompromiseMutation,
    engine,
    "ensure_bound compromise mutation did not apply",
  );
  assert.notDeepEqual(
    relayErrorContractFailures({ engineRuntime: ensureCompromiseMutation }),
    [],
  );

  const preflightMutation = engine.replace(
    "self.persist_bind_state(&stored.conversation_id, BindState::OutcomeUnknown)?;",
    "// mutation: omitted durable preflight",
  );
  assert.notEqual(preflightMutation, engine, "preflight mutation did not apply");
  assert.notDeepEqual(
    relayErrorContractFailures({ engineRuntime: preflightMutation }),
    [],
  );

  const appendMutation = engine.replace(
    ".append(send_key, send_addr, ciphertext)",
    ".read(send_key, send_addr, ciphertext)",
  );
  assert.notEqual(appendMutation, engine, "APPEND reconciliation mutation did not apply");
  assert.notDeepEqual(
    relayErrorContractFailures({ engineRuntime: appendMutation }),
    [],
  );

  const theftStatusMutation = mutateRustFunction(engine, "deliver", (body) =>
    body.replace(
      "self.mark_send_address_stolen_delivery(msg_id, now);",
      "let _mutation_skips_the_failed_delivery_write = (msg_id, now);",
    ),
  );
  assert.notDeepEqual(
    relayErrorContractFailures({ engineRuntime: theftStatusMutation }),
    [],
  );

  const theftStatusFailureMutation = mutateRustFunction(
    engine,
    "mark_send_address_stolen_delivery",
    (body) => body.replace(
      "if let Err(error) =",
      "if let Ok(error) =",
    ),
  );
  assert.notDeepEqual(
    relayErrorContractFailures({ engineRuntime: theftStatusFailureMutation }),
    [],
  );

  const appendOrderMutation = mutateRustFunction(
    engine,
    "append_and_confirm_binding",
    (body) => body.replace(
      "        self.connections",
      "        self.persist_bind_state(&stored.conversation_id, BindState::Confirmed)?;\n        self.connections",
    ),
  );
  assert.notDeepEqual(
    relayErrorContractFailures({ engineRuntime: appendOrderMutation }),
    [],
  );

  const confirmationFailureMutation = mutateRustFunction(
    engine,
    "append_and_confirm_binding",
    (body) => body.replace("&& let Err(error) =", "&& let Ok(error) ="),
  );
  assert.notDeepEqual(
    relayErrorContractFailures({ engineRuntime: confirmationFailureMutation }),
    [],
  );

  const alarmOrderMutation = mutateRustFunction(
    engine,
    "persist_and_emit_send_address_stolen",
    (body) => body.replace(
      "        self.records().commit(|records| {",
      "        self.sink.alarm(alarm);\n        self.records().commit(|records| {",
    ),
  );
  assert.notDeepEqual(
    relayErrorContractFailures({ engineRuntime: alarmOrderMutation }),
    [],
  );

  const downgradeMutation = mutateRustFunction(
    engine,
    "persist_bind_state",
    (body) => body.replace(
      "queue.bound = state != BindState::Fresh;",
      "queue.bound = state == BindState::Confirmed;",
    ),
  );
  assert.notDeepEqual(
    relayErrorContractFailures({ engineRuntime: downgradeMutation }),
    [],
  );

  const canonicalUnknownMutation = mutateRustFunction(
    engine,
    "ensure_bound",
    (body) => body.replace(
      "if outbound.bind_state != Some(BindState::OutcomeUnknown) || !outbound.bound {",
      "if false {",
    ),
  );
  assert.notDeepEqual(
    relayErrorContractFailures({ engineRuntime: canonicalUnknownMutation }),
    [],
  );

  for (const constructor of ["join_conversation", "set_peer_advert"]) {
    const constructorMutation = mutateRustFunction(engine, constructor, (body) => body.replace(
      "bind_state: Some(BindState::Fresh)",
      "bind_state: Some(BindState::OutcomeUnknown)",
    ));
    assert.notDeepEqual(
      relayErrorContractFailures({ engineRuntime: constructorMutation }),
      [],
      `${constructor} Fresh mutation escaped`,
    );
  }

  const identicalAdvertMutation = mutateRustFunction(engine, "set_peer_advert", (body) =>
    body.replace("        if identical {", "        if false && identical {"),
  );
  assert.notDeepEqual(
    relayErrorContractFailures({ engineRuntime: identicalAdvertMutation }),
    [],
  );

  const advertCommitOrderMutation = mutateRustFunction(engine, "set_peer_advert", (body) =>
    body.replace(
      "        self.records()",
      "        if let Some(identity) = &old_identity { self.volatile_compromise_alarms.remove(identity); }\n        self.records()",
    ),
  );
  assert.notDeepEqual(
    relayErrorContractFailures({ engineRuntime: advertCommitOrderMutation }),
    [],
  );

  const unenrollOrderMutation = mutateRustFunction(engine, "unenroll", (body) =>
    body.replace(
      "        let ids = inner.records().conversation_ids()?;",
      "        inner.volatile_compromise_alarms.clear();\n        let ids = inner.records().conversation_ids()?;",
    ),
  );
  assert.notDeepEqual(
    relayErrorContractFailures({ engineRuntime: unenrollOrderMutation }),
    [],
  );

  const leaveOrderMutation = mutateRustFunction(engine, "leave_conversation", (body) =>
    body.replace(
      "        inner.groups.remove(conversation_id);",
      "        inner.volatile_compromise_alarms.remove(&old_identity.clone().unwrap());\n        inner.groups.remove(conversation_id);",
    ),
  );
  assert.notDeepEqual(
    relayErrorContractFailures({ engineRuntime: leaveOrderMutation }),
    [],
  );

  const replacementContractMutation = contract.replace(
    "Authenticated replay of an identical queue advert",
    "Authenticated delivery of a queue advert",
  );
  assert.notEqual(
    replacementContractMutation,
    contract,
    "replacement contract mutation did not apply",
  );
  assert.notDeepEqual(
    relayErrorContractFailures({ clientContract: replacementContractMutation }),
    [],
  );

  const internalContractMutation = contract.replace(
    "either the local engine faulted or a relay or directory reported its own `ERR_INTERNAL`",
    "the local engine faulted",
  );
  assert.notEqual(internalContractMutation, contract, "internal contract mutation did not apply");
  assert.notDeepEqual(
    relayErrorContractFailures({ clientContract: internalContractMutation }),
    [],
  );

  const internalRuntimeMutation = models.replace(
    "component-internal fault: either this engine failed locally",
    "local engine fault",
  );
  assert.notEqual(internalRuntimeMutation, models, "internal runtime mutation did not apply");
  assert.notDeepEqual(
    relayErrorContractFailures({ publicModels: internalRuntimeMutation }),
    [],
  );

  const componentSection =
    "// component-internal (local engine or peer-reported relay/directory fault)";
  const internalUnionMutation = contract.replace(
    `${componentSection}\n  | "internal";`,
    `| "internal";\n  ${componentSection}`,
  );
  assert.notEqual(
    internalUnionMutation,
    contract,
    "CLIENT-CONTRACT internal classification mutation did not apply",
  );
  assert.notDeepEqual(
    relayErrorContractFailures({ clientContract: internalUnionMutation }),
    [],
  );

  const internalSchemaMutation = types.replace(
    `${componentSection}\n  "internal",`,
    `"internal",\n  ${componentSection}`,
  );
  assert.notEqual(
    internalSchemaMutation,
    types,
    "shipping internal classification mutation did not apply",
  );
  assert.notDeepEqual(
    relayErrorContractFailures({ shippingTypes: internalSchemaMutation }),
    [],
  );

  const alarmContractMutation = contract.replace(
    "  relayUrl: string | null;       // required for queue/relay attribution\n",
    "",
  );
  assert.notEqual(alarmContractMutation, contract, "Alarm contract mutation did not apply");
  assert.notDeepEqual(
    relayErrorContractFailures({ clientContract: alarmContractMutation }),
    [],
  );

  const alarmSchemaMutation = types.replace("  relayUrl: z.string().nullable(),\n", "");
  assert.notEqual(alarmSchemaMutation, types, "Alarm schema mutation did not apply");
  assert.notDeepEqual(
    relayErrorContractFailures({ shippingTypes: alarmSchemaMutation }),
    [],
  );

  const alarmModelMutation = models.replace(
    "#[serde(default)]\n    pub relay_url: Option<String>",
    "pub relay_url: Option<String>",
  );
  assert.notEqual(alarmModelMutation, models, "Alarm model mutation did not apply");
  assert.notDeepEqual(
    relayErrorContractFailures({ publicModels: alarmModelMutation }),
    [],
  );

  const alarmFieldMutation = mutateRustFunction(engine, "send_address_stolen_alarm", (body) =>
    body.replace("relay_url: Some(relay_url.to_owned())", "relay_url: None"),
  );
  assert.notDeepEqual(
    relayErrorContractFailures({ engineRuntime: alarmFieldMutation }),
    [],
  );

  const alarmCallMutation = engine.replace(
    "send_address_stolen_alarm(&current.peer_handle, &outbound.relay_url)",
    "send_address_stolen_alarm(&current.peer_handle, \"unknown relay\")",
  );
  assert.notEqual(alarmCallMutation, engine, "Alarm attribution call mutation did not apply");
  assert.notDeepEqual(
    relayErrorContractFailures({ engineRuntime: alarmCallMutation }),
    [],
  );

  const replacementKeyMutation = mutateRustFunction(engine, "set_peer_advert", (body) =>
    body.replace(
      "rand::rng().fill_bytes(&mut send_key_seed);",
      "send_key_seed = self.queue_key(conversation_id, LABEL_QUEUE_SEND)?;",
    ),
  );
  assert.notDeepEqual(
    relayErrorContractFailures({ engineRuntime: replacementKeyMutation }),
    [],
  );

  const volatileListMutation = mutateRustFunction(engine, "alarms", (body) =>
    body.replace("for alarm in self.volatile_compromise_alarms.values()", "for alarm in [].iter()"),
  );
  assert.notDeepEqual(
    relayErrorContractFailures({ engineRuntime: volatileListMutation }),
    [],
  );

  const acknowledgeBlockerMutation = mutateRustFunction(engine, "acknowledge_alarm", (body) =>
    body.replace(
      "records.put_conversation(stored)?;",
      "let _mutation_drops_the_durable_queue_blocker = stored;",
    ),
  );
  assert.notDeepEqual(
    relayErrorContractFailures({ engineRuntime: acknowledgeBlockerMutation }),
    [],
  );

  for (const name of ["set_peer_advert", "unenroll", "leave_conversation"]) {
    const flushMutation = mutateRustFunction(engine, name, (body) =>
      body.replace("records.put_alarms(&alarms)", "Ok(())"),
    );
    assert.notDeepEqual(
      relayErrorContractFailures({ engineRuntime: flushMutation }),
      [],
      `${name} volatile alarm flush mutation escaped`,
    );
  }

  const neutralContractMutation = contract.replace(
    "The result does not identify who bound it.",
    "The relay operator bound it.",
  );
  assert.notEqual(neutralContractMutation, contract, "neutral contract mutation did not apply");
  assert.notDeepEqual(
    relayErrorContractFailures({ clientContract: neutralContractMutation }),
    [],
  );

  const neutralWireMutation = wire.replace(
    "the result\ndoes not identify who performed that bind.",
    "the relay operator performed that bind.",
  );
  assert.notEqual(neutralWireMutation, wire, "neutral WIRE mutation did not apply");
  assert.notDeepEqual(relayErrorContractFailures({ wireSpec: neutralWireMutation }), []);
});
