#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

function requireMatch(source, pattern, message) {
  if (!pattern.test(source)) throw new Error(message);
}

export function assertSeedCaptureBoundary(sources) {
  const {
    android,
    ios,
    rustCommands,
    models,
    defaults,
    session,
    bridge,
    desktopBridge,
    desktopSettings,
    flow,
    onboarding,
    reveal,
  } = sources;

  const created =
    models.match(/pub struct WalletCreated \{[\s\S]*?\n\}/)?.[0] ?? "";
  if (!created || /seed_phrase/.test(created)) {
    throw new Error(
      "wallet creation must not return a seed phrase to the renderer",
    );
  }
  requireMatch(
    session,
    /token = await this\.authority\.begin\(\)[\s\S]*await readPhrase\(token\)/,
    "capture protection and its exact token must precede the custody read",
  );
  requireMatch(
    session,
    /requestAnimationFrame\(\(\) => requestAnimationFrame\(release\)\)/,
    "native release must wait until the cleared renderer has painted",
  );
  const clearBody = session.match(
    /clear\(\): boolean \{([\s\S]*?)\n  \}\n\n  private async release/,
  )?.[1];
  if (
    !clearBody ||
    clearBody.indexOf("this.publish(null)") < 0 ||
    clearBody.indexOf("this.publish(null)") >
      clearBody.indexOf("this.release(token)")
  ) {
    throw new Error(
      "renderer clearing must precede asynchronous lease release",
    );
  }
  requireMatch(
    android,
    /args\.active[\s\S]*addFlags\(WindowManager\.LayoutParams\.FLAG_SECURE\)[\s\S]*sensitiveDisplayToken == args\.token[\s\S]*clearFlags\(WindowManager\.LayoutParams\.FLAG_SECURE\)/,
    "Android FLAG_SECURE must be active and exact-lease released",
  );
  requireMatch(
    android,
    /if \(sensitiveDisplayToken == null && !secureFlagReleasePending\) \{[\s\S]*secureFlagAddedByPlugin = !hasSecureFlag\(\)/,
    "Android must distinguish a pre-existing FLAG_SECURE owner",
  );
  const resumedRelease = android.match(
    /override fun onResume[\s\S]*?if \(sensitiveDisplayToken == null && secureFlagReleasePending\) \{([\s\S]*?)\n            \}/,
  )?.[1];
  if (
    !resumedRelease?.includes("if (secureFlagAddedByPlugin)") ||
    !resumedRelease.includes(
      "clearFlags(WindowManager.LayoutParams.FLAG_SECURE)",
    )
  ) {
    throw new Error("Android resume may clear only plugin-owned FLAG_SECURE");
  }
  requireMatch(
    android,
    /currentState\?\.isAtLeast\(Lifecycle\.State\.RESUMED\)[\s\S]*secureFlagReleasePending = secureFlagAddedByPlugin/,
    "Android must retain FLAG_SECURE across a background release until resume",
  );
  for (const lifecycle of [
    "willResignActiveNotification",
    "didEnterBackgroundNotification",
    "didBecomeActiveNotification",
    "capturedDidChangeNotification",
  ]) {
    if (!ios.includes(lifecycle))
      throw new Error(`iOS is missing ${lifecycle}`);
  }
  const resignBranch = ios.match(
    /if name == UIApplication\.willResignActiveNotification([\s\S]*?)\} else \{/,
  )?.[1];
  if (!resignBranch?.includes("self.installSensitiveCover()")) {
    throw new Error(
      "iOS must install its cover synchronously for background snapshots",
    );
  }
  requireMatch(
    ios,
    /applicationState != \.active \|\| UIScreen\.main\.isCaptured/,
    "iOS must obscure inactive and captured displays",
  );
  const releaseBranch = ios.match(
    /else if self\.sensitiveDisplayToken == args\.token \{([\s\S]*?)\n            \}\n            \/\/ A stale release/,
  )?.[1];
  if (
    !releaseBranch?.includes(
      "UIApplication.shared.applicationState == .active",
    ) ||
    !releaseBranch.includes("self.installSensitiveCover()")
  ) {
    throw new Error(
      "iOS must retain its cover when a lease is released in background",
    );
  }
  requireMatch(
    rustCommands,
    /if !owns_sensitive_display\(&current, &args\.token\)[\s\S]*return Ok\(\(\)\)/,
    "Rust authority must ignore stale lease releases",
  );
  requireMatch(
    models,
    /pub struct SensitiveDisplayState \{\s*pub token: String,\s*pub wallet_id: String,\s*pub consumed: bool,\s*\}/,
    "native display state must bind token, wallet identity, and one-use state",
  );
  const beginStart = rustCommands.indexOf(
    "pub(crate) async fn begin_sensitive_display",
  );
  const beginEnd = rustCommands.indexOf(
    "/// Release capture protection",
    beginStart,
  );
  const beginBody =
    beginStart >= 0 && beginEnd > beginStart
      ? rustCommands.slice(beginStart, beginEnd)
      : "";
  for (const boundary of [
    "lock_wallet_transition().await",
    ".active_wallet_id()",
    "sensitive_display.lock().await",
    "SensitiveDisplayState {",
    "wallet_id,",
    "consumed: false",
  ]) {
    if (!beginBody.includes(boundary)) {
      throw new Error(
        `native display acquisition is missing wallet-bound state: ${boundary}`,
      );
    }
  }
  if (
    beginBody.indexOf("lock_wallet_transition().await") >
      beginBody.indexOf(".active_wallet_id()") ||
    beginBody.indexOf(".active_wallet_id()") >
      beginBody.indexOf("sensitive_display.lock().await")
  ) {
    throw new Error(
      "native display acquisition must bind the active wallet under the transition lock",
    );
  }
  const consumeStart = rustCommands.indexOf(
    "async fn consume_sensitive_display",
  );
  const consumeEnd = rustCommands.indexOf("#[cfg(test)]", consumeStart);
  const consumeBody =
    consumeStart >= 0 && consumeEnd > consumeStart
      ? rustCommands.slice(consumeStart, consumeEnd)
      : "";
  for (const boundary of [
    "token.is_empty()",
    "lease.token != token",
    "lease.wallet_id != wallet_id",
    "|| lease.consumed {",
    "lease.consumed = true",
    "Ok(guard)",
  ]) {
    if (!consumeBody.includes(boundary)) {
      throw new Error(
        `native mnemonic lease consumption is missing: ${boundary}`,
      );
    }
  }
  if (
    consumeBody.indexOf("lease.consumed = true") >
    consumeBody.indexOf("Ok(guard)")
  ) {
    throw new Error("native mnemonic lease must be consumed before custody");
  }
  for (const [command, terminator, walletBinding] of [
    ["get_seed_phrase", "/// Retrieve the recovery phrase", "&wallet_id"],
    [
      "get_backup_seed_phrase",
      "#[command]\npub(crate) async fn confirm_wallet_backup",
      "&args.wallet_id",
    ],
  ]) {
    const start = rustCommands.indexOf(`pub(crate) async fn ${command}`);
    const end = rustCommands.indexOf(terminator, start);
    const body =
      start >= 0 && end > start ? rustCommands.slice(start, end) : "";
    const transition = body.indexOf("lock_wallet_transition().await");
    const guard = body.indexOf("let _sensitive_guard =");
    const consume = body.indexOf("consume_sensitive_display(");
    const consumeWallet = body.indexOf(walletBinding, consume);
    const custody = body.lastIndexOf(".get_seed_phrase(");
    if (
      transition < 0 ||
      guard < transition ||
      consume < transition ||
      consume < guard ||
      consumeWallet < consume ||
      custody < consume ||
      body.slice(consume, custody).includes("drop(_sensitive_guard)")
    ) {
      throw new Error(
        `${command} must consume and hold the exact wallet-bound display lease across custody`,
      );
    }
  }
  for (const permission of [
    '"allow-begin-sensitive-display"',
    '"allow-end-sensitive-display"',
  ]) {
    if (!defaults.includes(permission)) {
      throw new Error(`zcash:default is missing ${permission}`);
    }
  }
  const spendingStatus =
    models.match(/pub struct SpendingKeyStatus \{[\s\S]*?\n\}/)?.[0] ?? "";
  if (!spendingStatus || /seed|phrase|key:/i.test(spendingStatus)) {
    throw new Error(
      "SpendingKeyStatus must contain status only, never secret material",
    );
  }
  if (/CopyButton|navigator\.clipboard/.test(onboarding)) {
    throw new Error("seed onboarding must not expose clipboard authority");
  }
  requireMatch(
    bridge,
    /beginSensitiveDisplay[\s\S]*invoke\("begin_sensitive_display"\)[\s\S]*endSensitiveDisplay[\s\S]*invoke\("end_sensitive_display", \{ args: \{ token \} \}\)/,
    "renderer bridge must invoke both exact native lease commands",
  );
  requireMatch(
    bridge,
    /getSeedPhrase\(token: string\)[\s\S]*invoke\("get_seed_phrase", \{ args: \{ token \} \}\)[\s\S]*getBackupSeedPhrase\(walletId: string, token: string\)[\s\S]*args: \{ walletId, token \}/,
    "mnemonic bridge calls must carry the exact display token",
  );
  requireMatch(
    desktopBridge,
    /beginSensitiveDisplay[\s\S]*invoke\("plugin:zcash\|begin_sensitive_display"\)[\s\S]*endSensitiveDisplay\(token: string\)[\s\S]*invoke\("plugin:zcash\|end_sensitive_display", \{ args: \{ token \} \}\)[\s\S]*getSeedPhrase\(token: string\)[\s\S]*invoke\("plugin:zcash\|get_seed_phrase", \{ args: \{ token \} \}\)/,
    "desktop mnemonic bridge must acquire, pass, and release the exact native lease",
  );
  requireMatch(
    desktopSettings,
    /beginSensitiveDisplay\(\)[\s\S]*api\.getSeedPhrase\(token\)/,
    "desktop recovery reveal must protect the native custody read",
  );
  for (const boundary of [
    'addEventListener("blur"',
    'addEventListener("pagehide"',
    'addEventListener("visibilitychange"',
    "setPhrase(null)",
    "releaseSensitiveLease()",
    'aria-hidden="true"',
  ]) {
    if (!desktopSettings.includes(boundary)) {
      throw new Error(
        `desktop recovery reveal is missing lifecycle boundary: ${boundary}`,
      );
    }
  }
  for (const renderer of [flow, onboarding]) {
    for (const boundary of [
      "new SensitiveSeedSession",
      'addEventListener("blur"',
      'addEventListener("pagehide"',
      'addEventListener("visibilitychange"',
      ".clear()",
    ]) {
      if (!renderer.includes(boundary)) {
        throw new Error(
          `seed renderer is missing lifecycle boundary: ${boundary}`,
        );
      }
    }
  }
  requireMatch(
    flow,
    /const \{ walletId \} = await wallet\.createWallet\(\)[\s\S]*setPhase\("backupRequired"\)/,
    "new identity flow must not receive a mnemonic before explicit reveal",
  );
  for (const renderer of [onboarding, reveal]) {
    if (!renderer.includes('aria-hidden="true"')) {
      throw new Error(
        "rendered mnemonic must be excluded from accessibility snapshots",
      );
    }
  }
}

export async function main() {
  const base = new URL("../", import.meta.url);
  const read = (relative) => readFile(new URL(relative, base), "utf8");
  const [
    android,
    ios,
    rustCommands,
    models,
    defaults,
    session,
    bridge,
    desktopBridge,
    desktopSettings,
    flow,
    onboarding,
    reveal,
  ] = await Promise.all([
    read("../plugins/tauri-plugin-zcash/android/src/main/java/ZcashPlugin.kt"),
    read("../plugins/tauri-plugin-zcash/ios/Sources/ZcashPlugin.swift"),
    read("../plugins/tauri-plugin-zcash/src/commands.rs"),
    read("../plugins/tauri-plugin-zcash/src/models.rs"),
    read("../plugins/tauri-plugin-zcash/permissions/default.toml"),
    read("src/lib/wallet/sensitive-seed.ts"),
    read("src/lib/wallet/bridge.ts"),
    read("../zuuallet/src/lib/tauri.ts"),
    read("../zuuallet/src/pages/Settings.tsx"),
    read("src/features/auth/useZcashChallengeFlow.ts"),
    read("src/features/wallet/Onboarding.tsx"),
    read("src/features/auth/SeedReveal.tsx"),
  ]);
  assertSeedCaptureBoundary({
    android,
    ios,
    rustCommands,
    models,
    defaults,
    session,
    bridge,
    desktopBridge,
    desktopSettings,
    flow,
    onboarding,
    reveal,
  });
  console.log(
    "Seed reveal native capture and renderer custody boundaries verified.",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
