import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertSeedCaptureBoundary } from "./seed-capture-boundary.mjs";

const base = new URL("../", import.meta.url);
const read = (relative) => readFile(new URL(relative, base), "utf8");
const sources = Object.fromEntries(
  await Promise.all(
    Object.entries({
      android:
        "../plugins/tauri-plugin-zcash/android/src/main/java/ZcashPlugin.kt",
      ios: "../plugins/tauri-plugin-zcash/ios/Sources/ZcashPlugin.swift",
      rustCommands: "../plugins/tauri-plugin-zcash/src/commands.rs",
      rustKeys: "../plugins/tauri-plugin-zcash/src/wallet/keys.rs",
      models: "../plugins/tauri-plugin-zcash/src/models.rs",
      defaults: "../plugins/tauri-plugin-zcash/permissions/default.toml",
      session: "src/lib/wallet/sensitive-seed.ts",
      bridge: "src/lib/wallet/bridge.ts",
      desktopSession: "../zuuallet/src/lib/sensitive-seed.ts",
      desktopSessionCore: "../zuuallet/src/lib/sensitive-seed-session.ts",
      desktopBridge: "../zuuallet/src/lib/tauri.ts",
      desktopMnemonicPolicy: "../zuuallet/src/lib/mnemonic.ts",
      desktopSettings: "../zuuallet/src/pages/Settings.tsx",
      desktopRestore: "../zuuallet/src/pages/RestoreWallet.tsx",
      desktopCreate: "../zuuallet/src/pages/CreateWallet.tsx",
      desktopWelcome: "../zuuallet/src/pages/Welcome.tsx",
      desktopHook: "../zuuallet/src/hooks/useWallet.ts",
      desktopTypes: "../zuuallet/src/types/index.ts",
      verificationDocs: "docs/seed-capture-device-verification.md",
      flow: "src/features/auth/useZcashChallengeFlow.ts",
      loginHook: "src/features/auth/useZcashLogin.ts",
      associateHook: "src/features/auth/useZcashAssociate.ts",
      loginFlow: "src/features/auth/ZcashLoginFlow.tsx",
      linkedAccounts: "src/features/profile/LinkedAccounts.tsx",
      mnemonicPolicy: "src/lib/wallet/mnemonic.ts",
      onboarding: "src/features/wallet/Onboarding.tsx",
      restoreIdentity: "src/features/auth/RestoreIdentity.tsx",
      reveal: "src/features/auth/SeedReveal.tsx",
    }).map(async ([key, path]) => [key, await read(path)]),
  ),
);

test("current seed capture boundary passes", () => {
  assert.doesNotThrow(() => assertSeedCaptureBoundary(sources));
});

for (const [name, key, search, replacement] of [
  [
    "legacy wallet creation count no longer fails closed",
    "models",
    '#[serde(rename_all = "camelCase", deny_unknown_fields)]\npub struct CreateWalletArgs',
    '#[serde(rename_all = "camelCase")]\npub struct CreateWalletArgs',
  ],
  [
    "legacy wallet creation count is reintroduced",
    "models",
    "pub name: Option<String>,\n}",
    "pub name: Option<String>,\n    pub mnemonic_word_count: Option<u32>,\n}",
  ],
  [
    "native creation regresses to 12 words",
    "rustKeys",
    "Mnemonic::generate(Count::Words24)",
    "Mnemonic::generate(Count::Words12)",
  ],
  [
    "native creation regains a word-count parameter",
    "rustKeys",
    "pub fn generate_mnemonic() -> Mnemonic",
    "pub fn generate_mnemonic(word_count: u32) -> Mnemonic",
  ],
  [
    "native command accepts caller-controlled word count",
    "rustCommands",
    "let mnemonic = keys::generate_mnemonic();",
    "let word_count = 12;\n    let mnemonic = keys::generate_mnemonic(word_count);",
  ],
  [
    "ZUULI bridge restores caller-controlled word count",
    "bridge",
    "async createWallet(name?: string): Promise<WalletCreated>",
    "async createWallet(mnemonicWordCount = 12, name?: string): Promise<WalletCreated>",
  ],
  [
    "Zuuallet bridge restores caller-controlled word count",
    "desktopBridge",
    "createWallet(name?: string): Promise<WalletCreated>",
    "createWallet(mnemonicWordCount = 12, name?: string): Promise<WalletCreated>",
  ],
  [
    "wallet onboarding requests a short phrase",
    "onboarding",
    "wallet.createWallet()",
    "wallet.createWallet(12)",
  ],
  [
    "Zuuallet hook requests a short phrase",
    "desktopHook",
    "api.createWallet(name)",
    "api.createWallet(12, name)",
  ],
  [
    "shared auth and link flow requests a short phrase",
    "flow",
    "wallet.createWallet()",
    "wallet.createWallet(12)",
  ],
  [
    "login UI injects a creation count",
    "loginFlow",
    "void createIdentity();",
    "void createIdentity(12);",
  ],
  [
    "linked-account UI injects a creation count",
    "linkedAccounts",
    "void createIdentity()",
    "void createIdentity(12)",
  ],
  [
    "ZUULI drops 15-word restore compatibility",
    "mnemonicPolicy",
    "[12, 15, 18, 21, 24]",
    "[12, 18, 21, 24]",
  ],
  [
    "Zuuallet drops 21-word restore compatibility",
    "desktopMnemonicPolicy",
    "[12, 15, 18, 21, 24]",
    "[12, 15, 18, 24]",
  ],
  [
    "wallet onboarding narrows restore to 24 words",
    "onboarding",
    "isSupportedBip39WordCount(wordCount)",
    "wordCount === 24",
  ],
  [
    "identity restore bypasses the shared length policy",
    "restoreIdentity",
    "isSupportedBip39WordCount(wordCount)",
    "wordCount === 24",
  ],
  [
    "identity restore submits an unsupported word count",
    "restoreIdentity",
    "if (!supportedWordCount) {",
    "if (false) {",
  ],
  [
    "identity restore enables unsupported word counts",
    "restoreIdentity",
    "disabled={restoring || !supportedWordCount}",
    "disabled={restoring}",
  ],
  [
    "Zuuallet restore narrows compatibility to 24 words",
    "desktopRestore",
    "isSupportedBip39WordCount(wordCount)",
    "wordCount === 24",
  ],
  [
    "Zuuallet recovery re-link narrows compatibility to 24 words",
    "desktopSettings",
    "isSupportedBip39WordCount(wordCount)",
    "wordCount === 24",
  ],
  [
    "creation response leaks seed",
    "models",
    "pub wallet_id: String,",
    "pub wallet_id: String,\n    pub seed_phrase: String,",
  ],
  [
    "Android secure flag removed",
    "android",
    "addFlags(WindowManager.LayoutParams.FLAG_SECURE)",
    "addFlags(0)",
  ],
  [
    "Android stale release can clear",
    "android",
    "sensitiveDisplayToken == args.token",
    "sensitiveDisplayToken != null",
  ],
  [
    "Android background release clears immediately",
    "android",
    "secureFlagReleasePending = secureFlagAddedByPlugin",
    "activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)",
  ],
  [
    "Android claims a pre-existing secure flag",
    "android",
    "secureFlagAddedByPlugin = !hasSecureFlag()",
    "secureFlagAddedByPlugin = true",
  ],
  [
    "Android superseding lease loses plugin flag ownership",
    "android",
    "if (sensitiveDisplayToken == null && !secureFlagReleasePending) {",
    "if (true) {",
  ],
  [
    "Android failed replacement discards the preceding lease",
    "android",
    "sensitiveDisplayToken = previousToken\n                    secureFlagReleasePending = previousReleasePending",
    "sensitiveDisplayToken = null\n                    secureFlagReleasePending = false",
  ],
  [
    "Android pending-background reacquire loses plugin flag ownership",
    "android",
    "if (sensitiveDisplayToken == null && !secureFlagReleasePending) {",
    "if (sensitiveDisplayToken == null) {",
  ],
  [
    "Android resume clears independent protection",
    "android",
    "if (secureFlagAddedByPlugin) {\n                    activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)",
    "if (true) {\n                    activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)",
  ],
  [
    "iOS capture observer removed",
    "ios",
    "UIScreen.capturedDidChangeNotification",
    'Notification.Name("decoy")',
  ],
  [
    "iOS background cover removed",
    "ios",
    "            showSensitiveCovers()",
    "            updateSensitiveCovers()",
  ],
  [
    "iOS release drops background cover",
    "ios",
    "showSensitiveCovers()\n            }\n        }\n        // A stale release",
    "removeSensitiveCovers()\n            }\n        }\n        // A stale release",
  ],
  [
    "iOS active begin does not prove an attachable cover",
    "ios",
    "if !prepareSensitiveCovers(obscureAll: appIsInactive) {",
    "if appIsInactive && !prepareSensitiveCovers(obscureAll: true) {",
  ],
  [
    "iOS failed replacement dismantles the preceding lease",
    "ios",
    "sensitiveDisplayToken = previousToken\n                if previousToken == nil {",
    "sensitiveDisplayToken = nil\n                if true {",
  ],
  [
    "iOS secondary display trusts main-screen capture state",
    "ios",
    "let mustObscure = obscureAll || window.screen.isCaptured",
    "let mustObscure = obscureAll || UIScreen.main.isCaptured",
  ],
  [
    "iOS sensitive invocation remains on the Tauri IPC queue",
    "ios",
    "DispatchQueue.main.async {",
    "DispatchQueue.global().async {",
  ],
  [
    "iOS mutable cover state loses main-actor isolation",
    "ios",
    "@MainActor\n    private func applySensitiveDisplay",
    "private func applySensitiveDisplay",
  ],
  [
    "iOS cover regresses to one key window",
    "ios",
    ".flatMap { scene in scene.windows }",
    ".compactMap { scene in scene.windows.first(where: \\.isKeyWindow) }",
  ],
  [
    "Rust accepts stale release",
    "rustCommands",
    "if !owns_sensitive_display(&current, &args.token)",
    "if current.is_none()",
  ],
  [
    "renderer clear removed",
    "session",
    "++this.generation;\n    this.publish(null);\n    const token",
    "++this.generation;\n    // omitted\n    const token",
  ],
  [
    "renderer reveal loses module-wide arbitration",
    "session",
    "if (revealInFlight) return false;",
    "// overlapping reveal accepted",
  ],
  [
    "Zuuallet reveal loses module-wide arbitration",
    "desktopSessionCore",
    "if (revealInFlight) return false;",
    "// overlapping reveal accepted",
  ],
  [
    "native release runs before renderer paint",
    "session",
    "requestAnimationFrame(() => requestAnimationFrame(release));",
    "release();",
  ],
  [
    "clipboard restored",
    "onboarding",
    "const [confirmed",
    "navigator.clipboard;\n  const [confirmed",
  ],
  [
    "auth blur clearing removed",
    "flow",
    'window.addEventListener("blur", hideSeedBackup);',
    "// omitted",
  ],
  [
    "onboarding visibility clearing removed",
    "onboarding",
    'document.addEventListener("visibilitychange", onVisibility);',
    "// omitted",
  ],
  [
    "onboarding acknowledgement loses synchronous serialization",
    "onboarding",
    "if (!confirmed || operationInFlight.current) return;",
    "if (!confirmed) return;",
  ],
  [
    "native lease bridge bypassed",
    "bridge",
    'return invoke("begin_sensitive_display");',
    'return Promise.resolve({ token: "decorative" });',
  ],
  [
    "default permission cannot acquire display protection",
    "defaults",
    '    "allow-begin-sensitive-display",',
    "    # omitted",
  ],
  [
    "native mnemonic read bypasses exact lease",
    "rustCommands",
    "        consume_sensitive_display(&zcash.sensitive_display, &args.token, &wallet_id).await?;",
    "    let _sensitive_guard = zcash.sensitive_display.lock().await;",
  ],
  [
    "native display lease drops wallet binding",
    "rustCommands",
    "lease.wallet_id != wallet_id",
    "false",
  ],
  [
    "native display lease becomes reusable",
    "rustCommands",
    " || lease.consumed",
    "",
  ],
  [
    "native display acquisition omits active wallet identity",
    "rustCommands",
    "        wallet_id,\n        consumed: false,",
    '        wallet_id: "decorative".to_owned(),\n        consumed: false,',
  ],
  [
    "native display acquisition replaces a consumed lease",
    "rustCommands",
    "    ensure_sensitive_display_replaceable(&current)?;",
    "    // consumed lease replacement accepted",
  ],
  [
    "native custody drops consumed lease before read",
    "rustCommands",
    "    zcash\n        .state\n        .get_seed_phrase(&transition_guard, &wallet_id)",
    "    drop(_sensitive_guard);\n    zcash\n        .state\n        .get_seed_phrase(&transition_guard, &wallet_id)",
  ],
  [
    "renderer custody read omits exact lease token",
    "session",
    "const phrase = await readPhrase(token);",
    "const phrase = await readPhrase();",
  ],
  [
    "desktop custody read omits exact lease token",
    "desktopSettings",
    "api.getSeedPhrase(token),",
    "api.getSeedPhrase(),",
  ],
  [
    "desktop background clearing removed",
    "desktopSettings",
    'window.addEventListener("pagehide", clearSensitiveDisplay);',
    "// omitted",
  ],
  [
    "desktop direct mnemonic bridge drops lease token",
    "desktopBridge",
    'return invoke("plugin:zcash|get_seed_phrase", { args: { token } });',
    'return invoke("plugin:zcash|get_seed_phrase");',
  ],
  [
    "Zuuallet creation trusts removed WalletCreated mnemonic",
    "desktopHook",
    "const result = await api.createWallet(name);",
    "const result = await api.createWallet(name);\n        setSeedPhrase(result.seedPhrase);",
  ],
  [
    "Zuuallet permits same-render duplicate wallet creation",
    "desktopWelcome",
    "if (createInFlight.current) return;",
    "// duplicate create accepted",
  ],
  [
    "Zuuallet creation reads custody without its lease",
    "desktopHook",
    "api.getBackupSeedPhrase(walletId, token)",
    "api.getSeedPhrase(token)",
  ],
  [
    "Zuuallet ignores a cold resumable backup gate",
    "desktopHook",
    "status.backupRequired && status.activeWalletId",
    "false",
  ],
  [
    "Zuuallet authentication cancellation strands the created wallet",
    "desktopHook",
    "createdSeedSession.currentWalletId === result.walletId",
    "false",
  ],
  [
    "Zuuallet creation releases before cleared paint",
    "desktopSessionCore",
    "requestAnimationFrame(() => requestAnimationFrame(release));",
    "release();",
  ],
  [
    "Zuuallet backup bridge drops its exact lease token",
    "desktopBridge",
    "args: { walletId, token },",
    "args: { walletId },",
  ],
  [
    "Zuuallet acknowledgement accepts a wrong wallet",
    "desktopSessionCore",
    "walletId !== this.walletId",
    "false",
  ],
  [
    "Zuuallet acknowledgement permits double submission",
    "desktopSessionCore",
    "if (this.confirmationInFlight) return false;",
    "// duplicate confirmations permitted",
  ],
  [
    "Zuuallet releases protection before acknowledgement",
    "desktopSessionCore",
    "await confirmBackup(walletId);",
    "this.display.clear();\n      await confirmBackup(walletId);",
  ],
  [
    "Zuuallet acknowledgement failure drops protection",
    "desktopSessionCore",
    "} finally {\n      // This is a process-wide native side-effect lock",
    "} finally {\n      this.display.clear();\n      // This is a process-wide native side-effect lock",
  ],
  [
    "Zuuallet cancellation releases a pending acknowledgement lock",
    "desktopSessionCore",
    "cancel(): boolean {\n    const hadSession",
    "cancel(): boolean {\n    this.confirmationInFlight = false;\n    const hadSession",
  ],
  [
    "Zuuallet reveal overlaps a pending acknowledgement",
    "desktopSessionCore",
    'if (this.confirmationInFlight) {\n      throw new Error("Backup acknowledgement is still in progress.");\n    }',
    'if (false) {\n      throw new Error("Backup acknowledgement is still in progress.");\n    }',
  ],
  [
    "Zuuallet acknowledgement lock never releases",
    "desktopSessionCore",
    "this.confirmationInFlight = false;\n    }\n  }",
    "// acknowledgement lock omitted\n    }\n  }",
  ],
  [
    "Zuuallet created view skips native backup acknowledgement",
    "desktopCreate",
    "api.confirmWalletBackup,",
    "async () => undefined,",
  ],
  [
    "Zuuallet created mnemonic survives background",
    "desktopCreate",
    'window.addEventListener("pagehide", clearSensitiveSeed);',
    "// omitted",
  ],
  [
    "Zuuallet background clearing forgets the resumable wallet identity",
    "desktopCreate",
    "createdSeedSession.hide()",
    "createdSeedSession.cancel()",
  ],
  [
    "Zuuallet WalletCreated type invents a seed phrase",
    "desktopTypes",
    "  walletId: string;",
    "  seedPhrase: string;",
  ],
  [
    "Zuuallet created mnemonic enters accessibility tree",
    "desktopCreate",
    '<div aria-hidden="true">',
    "<div>",
  ],
  [
    "wallet creation consumes seed again",
    "flow",
    "const { walletId } = await wallet.createWallet();",
    "const { walletId, seedPhrase } = await wallet.createWallet();",
  ],
  [
    "accessibility exposes onboarding seed",
    "onboarding",
    'aria-hidden="true"',
    'aria-hidden="false"',
  ],
  [
    "accessibility exposes auth seed",
    "reveal",
    'aria-hidden="true"',
    "aria-hidden={revealed}",
  ],
  [
    "device guide claims active iOS still-screenshot protection",
    "verificationDocs",
    "active iOS still-screenshot protection is a known residual",
    "active iOS still-screenshot protection is verified",
  ],
]) {
  test(`rejects mutation: ${name}`, () => {
    const mutated = {
      ...sources,
      [key]: sources[key].replace(search, replacement),
    };
    assert.notEqual(
      mutated[key],
      sources[key],
      `fixture ${name} must mutate source`,
    );
    assert.throws(() => assertSeedCaptureBoundary(mutated));
  });
}

test("rejects mutation: custody read moved before protection", () => {
  const mutatedSession = sources.session
    .replace(
      "token = await this.authority.begin();",
      "token = await readPhrase().then(() => this.authority.begin());",
    )
    .replace(
      "const phrase = await readPhrase(token);",
      'const phrase = "already read before protection";',
    );
  assert.notEqual(mutatedSession, sources.session);
  assert.throws(() =>
    assertSeedCaptureBoundary({ ...sources, session: mutatedSession }),
  );
});
