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
      models: "../plugins/tauri-plugin-zcash/src/models.rs",
      defaults: "../plugins/tauri-plugin-zcash/permissions/default.toml",
      session: "src/lib/wallet/sensitive-seed.ts",
      bridge: "src/lib/wallet/bridge.ts",
      desktopBridge: "../zuuallet/src/lib/tauri.ts",
      desktopSettings: "../zuuallet/src/pages/Settings.tsx",
      flow: "src/features/auth/useZcashChallengeFlow.ts",
      onboarding: "src/features/wallet/Onboarding.tsx",
      reveal: "src/features/auth/SeedReveal.tsx",
    }).map(async ([key, path]) => [key, await read(path)]),
  ),
);

test("current seed capture boundary passes", () => {
  assert.doesNotThrow(() => assertSeedCaptureBoundary(sources));
});

for (const [name, key, search, replacement] of [
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
    "self.installSensitiveCover()",
    "self.updateSensitiveCover()",
  ],
  [
    "iOS release drops background cover",
    "ios",
    "self.installSensitiveCover()\n                }\n            }\n            // A stale release",
    "self.removeSensitiveCover()\n                }\n            }\n            // A stale release",
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
    "const result = await api.getSeedPhrase(token);",
    "const result = await api.getSeedPhrase();",
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
