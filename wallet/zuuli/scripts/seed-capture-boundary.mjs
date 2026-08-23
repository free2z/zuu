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
    desktopSession,
    desktopSessionCore,
    desktopBridge,
    desktopSettings,
    desktopCreate,
    desktopHook,
    desktopTypes,
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
  for (const [rendererSession, label] of [
    [session, "ZUULI"],
    [desktopSessionCore, "Zuuallet"],
  ]) {
    requireMatch(
      rendererSession,
      /token = await this\.authority\.begin\(\)[\s\S]*await readPhrase\(token\)/,
      `${label} capture protection and its exact token must precede custody`,
    );
    requireMatch(
      rendererSession,
      /requestAnimationFrame\(\(\) => requestAnimationFrame\(release\)\)/,
      `${label} native release must wait until the cleared renderer has painted`,
    );
    const clearBody = rendererSession.match(
      /clear\(\): boolean \{([\s\S]*?)\n  \}\n\n  private async release/,
    )?.[1];
    if (
      !clearBody ||
      clearBody.indexOf("this.publish(null)") < 0 ||
      clearBody.indexOf("this.publish(null)") >
        clearBody.indexOf("this.release(token)")
    ) {
      throw new Error(
        `${label} renderer clearing must precede asynchronous lease release`,
      );
    }
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
  requireMatch(
    android,
    /val previousToken = sensitiveDisplayToken[\s\S]*val previousReleasePending = secureFlagReleasePending[\s\S]*val previousFlagOwnership = secureFlagAddedByPlugin[\s\S]*if \(!hasSecureFlag\(\)\) \{[\s\S]*sensitiveDisplayToken = previousToken[\s\S]*secureFlagReleasePending = previousReleasePending[\s\S]*secureFlagAddedByPlugin = previousFlagOwnership/,
    "Android failed acquisition must preserve the preceding lease authority",
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
  const iosObserverNames =
    ios.match(
      /let names: \[Notification\.Name\] = \[([\s\S]*?)\n        \]/,
    )?.[1] ?? "";
  for (const lifecycle of [
    "willResignActiveNotification",
    "didEnterBackgroundNotification",
    "didBecomeActiveNotification",
    "capturedDidChangeNotification",
    "didBecomeVisibleNotification",
  ]) {
    if (!iosObserverNames.includes(lifecycle))
      throw new Error(`iOS is missing ${lifecycle}`);
  }
  const resignBranch = ios.match(
    /if name == UIApplication\.willResignActiveNotification([\s\S]*?)\} else \{/,
  )?.[1];
  if (!resignBranch?.includes("showSensitiveCovers()")) {
    throw new Error(
      "iOS must show its pre-attached covers synchronously for background snapshots",
    );
  }
  requireMatch(
    ios,
    /private final class SensitiveDisplayInvocation: @unchecked Sendable \{[\s\S]*let plugin: ZcashPlugin[\s\S]*let invoke: Invoke[\s\S]*let args: SensitiveDisplayArgs/,
    "iOS must transfer only one sensitive-display invocation across the Tauri IPC boundary",
  );
  requireMatch(
    ios,
    /let request = SensitiveDisplayInvocation\(plugin: self, invoke: invoke, args: args\)\s*DispatchQueue\.main\.async \{\s*request\.plugin\.applySensitiveDisplay\(request\)\s*\}/,
    "iOS must transfer the sensitive-display invocation from Tauri IPC to the main queue",
  );
  requireMatch(
    ios,
    /@MainActor\s*private func applySensitiveDisplay\(_ request: SensitiveDisplayInvocation\)/,
    "iOS mutable cover state must remain main-actor isolated",
  );
  if (/final class ZcashPlugin: Plugin[^\{]*@unchecked Sendable/.test(ios)) {
    throw new Error(
      "iOS must not claim the entire Tauri plugin is unchecked Sendable",
    );
  }
  requireMatch(
    ios,
    /let previousToken = sensitiveDisplayToken[\s\S]*if !prepareSensitiveCovers\(obscureAll: appIsInactive\) \{[\s\S]*sensitiveDisplayToken = previousToken[\s\S]*if previousToken == nil \{[\s\S]*removeSensitiveCovers\(\)[\s\S]*\} else \{[\s\S]*showSensitiveCovers\(\)[\s\S]*invoke\.reject\("iOS sensitive cover could not be installed"/,
    "iOS lease acquisition must fail closed unless active windows have pre-attached covers",
  );
  for (const boundary of [
    "private var obscuringViews: [ObjectIdentifier: UIView]",
    "let windows = sensitiveAppWindows()",
    "for window in windows",
    "UIApplication.shared.connectedScenes",
    "compactMap { scene in scene as? UIWindowScene }",
    "flatMap { scene in scene.windows }",
  ]) {
    if (!ios.includes(boundary)) {
      throw new Error(
        `iOS multi-window cover boundary is missing: ${boundary}`,
      );
    }
  }
  if (/keyWindow\(\)|first\(where: \\.isKeyWindow\)/.test(ios)) {
    throw new Error("iOS sensitive display must not depend on one key window");
  }
  requireMatch(
    ios,
    /let mustObscure = obscureAll \|\| window\.screen\.isCaptured[\s\S]*cover\.isHidden = !mustObscure/,
    "iOS must derive capture protection from each attached window's screen",
  );
  if (/UIScreen\.main\.isCaptured/.test(ios)) {
    throw new Error("iOS capture authority must not assume the main screen");
  }
  const releaseBranch = ios.match(
    /else if sensitiveDisplayToken == args\.token \{([\s\S]*?)\n        \}\n        \/\/ A stale release/,
  )?.[1];
  if (
    !releaseBranch?.includes(
      "UIApplication.shared.applicationState == .active",
    ) ||
    !releaseBranch.includes("showSensitiveCovers()")
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
    /beginSensitiveDisplay[\s\S]*invoke\("plugin:zcash\|begin_sensitive_display"\)[\s\S]*endSensitiveDisplay\(token: string\)[\s\S]*invoke\("plugin:zcash\|end_sensitive_display", \{ args: \{ token \} \}\)[\s\S]*getSeedPhrase\(token: string\)[\s\S]*invoke\("plugin:zcash\|get_seed_phrase", \{ args: \{ token \} \}\)[\s\S]*getBackupSeedPhrase\([\s\S]*walletId: string,[\s\S]*token: string,[\s\S]*invoke\("plugin:zcash\|get_backup_seed_phrase", \{[\s\S]*args: \{ walletId, token \}[\s\S]*confirmWalletBackup\(walletId: string\)[\s\S]*invoke\("plugin:zcash\|confirm_wallet_backup", \{[\s\S]*args: \{ walletId \}/,
    "desktop mnemonic bridge must bind the exact native lease, backup wallet, and acknowledgement",
  );
  requireMatch(
    desktopSettings,
    /new SensitiveSeedSession\([\s\S]*sensitiveSeedAuthority[\s\S]*\.reveal\(\(token\) =>[\s\S]*api\.getSeedPhrase\(token\)/,
    "desktop recovery reveal must protect the native custody read",
  );
  for (const boundary of [
    'addEventListener("blur"',
    'addEventListener("pagehide"',
    'addEventListener("visibilitychange"',
    "sensitiveSession.current?.clear()",
    'aria-hidden="true"',
  ]) {
    if (!desktopSettings.includes(boundary)) {
      throw new Error(
        `desktop recovery reveal is missing lifecycle boundary: ${boundary}`,
      );
    }
  }
  const desktopCreated =
    desktopTypes.match(/export interface WalletCreated \{[\s\S]*?\n\}/)?.[0] ??
    "";
  if (
    !desktopCreated.includes("walletId: string") ||
    !desktopCreated.includes("birthdayHeight: number") ||
    /seedPhrase/.test(desktopCreated)
  ) {
    throw new Error(
      "Zuuallet WalletCreated must match the native non-mnemonic response",
    );
  }
  const desktopStatus =
    desktopTypes.match(/export interface WalletStatus \{[\s\S]*?\n\}/)?.[0] ??
    "";
  if (!desktopStatus.includes("backupRequired: boolean")) {
    throw new Error(
      "Zuuallet WalletStatus must expose the native resumable backup gate",
    );
  }
  requireMatch(
    desktopSession,
    /createdSeedSession = new CreatedSeedSession\([\s\S]*new SensitiveSeedSession\(sensitiveSeedAuthority[\s\S]*useWalletStore\.getState\(\)\.setSeedPhrase/,
    "Zuuallet creation must retain its wallet-bound sensitive lease across the route transition",
  );
  requireMatch(
    desktopHook,
    /const result = await api\.createWallet\(24, name\)[\s\S]*createdSeedSession\.prepare\(result\.walletId\)[\s\S]*createdSeedSession\.reveal\([\s\S]*result\.walletId,[\s\S]*\(walletId, token\) =>\s*api\.getBackupSeedPhrase\(walletId, token\)[\s\S]*createdSeedSession\.currentWalletId === result\.walletId[\s\S]*setPage\("create"\)/,
    "Zuuallet creation must bind its protected backup read to WalletCreated.walletId",
  );
  requireMatch(
    desktopHook,
    /status\.backupRequired && status\.activeWalletId[\s\S]*createdSeedSession\.prepare\(status\.activeWalletId\)[\s\S]*setPage\("create"\)/,
    "Zuuallet must resume an unacknowledged native backup gate after restart",
  );
  if (/result\.seedPhrase/.test(desktopHook)) {
    throw new Error(
      "Zuuallet creation cannot trust a renderer seed in WalletCreated",
    );
  }
  requireMatch(
    desktopSessionCore,
    /class CreatedSeedSession[\s\S]*walletId: string \| null[\s\S]*get confirmationPending\(\): boolean[\s\S]*walletId !== this\.walletId/,
    "Zuuallet created-seed session must retain and exact-match its native wallet identity",
  );
  const revealStart = desktopSessionCore.indexOf("async reveal(");
  const confirmStart = desktopSessionCore.indexOf("async confirm(");
  const confirmEnd = desktopSessionCore.indexOf(
    "cancel(): boolean",
    confirmStart,
  );
  const hideStart = desktopSessionCore.indexOf("hide(): boolean", confirmEnd);
  const revealBody =
    revealStart >= 0 && confirmStart > revealStart
      ? desktopSessionCore.slice(revealStart, confirmStart)
      : "";
  const confirmBody =
    confirmStart >= 0 && confirmEnd > confirmStart
      ? desktopSessionCore.slice(confirmStart, confirmEnd)
      : "";
  const cancelBody =
    confirmEnd >= 0 && hideStart > confirmEnd
      ? desktopSessionCore.slice(confirmEnd, hideStart)
      : "";
  const hideBody = hideStart >= 0 ? desktopSessionCore.slice(hideStart) : "";
  const confirmAwait = confirmBody.indexOf("await confirmBackup(walletId)");
  const confirmClear = confirmBody.indexOf("this.display.clear()");
  const finallyBody =
    confirmBody.match(/finally \{([\s\S]*?)\n    \}/)?.[1] ?? "";
  if (
    !revealBody.includes("if (this.confirmationInFlight)") ||
    confirmAwait < 0 ||
    !confirmBody.includes("if (this.confirmationInFlight) return false;") ||
    !confirmBody.includes("this.confirmationInFlight = true;") ||
    !confirmBody.includes("const generation = this.generation;") ||
    !/generation !== this\.generation \|\| this\.walletId !== walletId/.test(
      confirmBody,
    ) ||
    confirmClear < confirmAwait ||
    !finallyBody.includes("this.confirmationInFlight = false;") ||
    finallyBody.includes("this.display.clear()") ||
    cancelBody.includes("this.confirmationInFlight = false;") ||
    hideBody.includes("this.confirmationInFlight = false;")
  ) {
    throw new Error(
      "Zuuallet must globally serialize native acknowledgement while making stale results inert",
    );
  }
  for (const boundary of [
    'addEventListener("blur"',
    'addEventListener("pagehide"',
    'addEventListener("visibilitychange"',
    "createdSeedSession.cancel()",
    'aria-hidden="true"',
  ]) {
    if (!desktopCreate.includes(boundary)) {
      throw new Error(
        `Zuuallet created-seed view is missing lifecycle boundary: ${boundary}`,
      );
    }
  }
  if (/navigator\.clipboard|CopyButton/.test(desktopCreate)) {
    throw new Error(
      "Zuuallet created seed must not expose clipboard authority",
    );
  }
  requireMatch(
    desktopCreate,
    /<div aria-hidden="true">\s*<SeedPhraseGrid phrase=\{seedPhrase\} \/>/,
    "Zuuallet created mnemonic must stay out of accessibility snapshots",
  );
  requireMatch(
    desktopCreate,
    /createdSeedSession\.hide\(\)[\s\S]*createdSeedSession\.reveal\([\s\S]*walletId,[\s\S]*api\.getBackupSeedPhrase\(exactWalletId, token\)/,
    "Zuuallet background clearing must preserve an exact re-authenticatable backup gate",
  );
  requireMatch(
    desktopCreate,
    /const walletId = createdSeedSession\.currentWalletId[\s\S]*createdSeedSession\.confirm\([\s\S]*walletId,[\s\S]*api\.confirmWalletBackup[\s\S]*if \(accepted\) setPage\("home"\)/,
    "Zuuallet may leave the backup gate only after exact native acknowledgement",
  );
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
  requireMatch(
    onboarding,
    /const operationInFlight = useRef\(false\)[\s\S]*const reveal = useCallback\(async \(\) => \{\s*if \(operationInFlight\.current\) return;\s*operationInFlight\.current = true;[\s\S]*const finish = useCallback\(async \(\) => \{\s*if \(!confirmed \|\| operationInFlight\.current\) return;\s*operationInFlight\.current = true;/,
    "seed onboarding must synchronously serialize reveal and acknowledgement",
  );
  const onboardingReveal = onboarding.match(
    /const reveal = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[created\.walletId\]\);/,
  )?.[1];
  const onboardingFinish = onboarding.match(
    /const finish = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[confirmed, created\.walletId, hide, onDone\]\);/,
  )?.[1];
  for (const [body, label] of [
    [onboardingReveal, "reveal"],
    [onboardingFinish, "acknowledgement"],
  ]) {
    const finallyBody = body?.match(/finally \{([\s\S]*?)\n    \}/)?.[1] ?? "";
    if (!finallyBody.includes("operationInFlight.current = false;")) {
      throw new Error(
        `seed onboarding ${label} must release its single-flight guard`,
      );
    }
  }
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
    desktopSession,
    desktopSessionCore,
    desktopBridge,
    desktopSettings,
    desktopCreate,
    desktopHook,
    desktopTypes,
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
    read("../zuuallet/src/lib/sensitive-seed.ts"),
    read("../zuuallet/src/lib/sensitive-seed-session.ts"),
    read("../zuuallet/src/lib/tauri.ts"),
    read("../zuuallet/src/pages/Settings.tsx"),
    read("../zuuallet/src/pages/CreateWallet.tsx"),
    read("../zuuallet/src/hooks/useWallet.ts"),
    read("../zuuallet/src/types/index.ts"),
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
    desktopSession,
    desktopSessionCore,
    desktopBridge,
    desktopSettings,
    desktopCreate,
    desktopHook,
    desktopTypes,
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
