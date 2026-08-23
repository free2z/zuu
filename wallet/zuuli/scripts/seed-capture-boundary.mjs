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
    session,
    bridge,
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
    /await this\.authority\.begin\(\)[\s\S]*await readPhrase\(\)/,
    "capture protection must be acquired before the custody read",
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
    /currentState\?\.isAtLeast\(Lifecycle\.State\.RESUMED\)[\s\S]*secureFlagReleasePending = true/,
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
  if (/CopyButton|navigator\.clipboard/.test(onboarding)) {
    throw new Error("seed onboarding must not expose clipboard authority");
  }
  requireMatch(
    bridge,
    /beginSensitiveDisplay[\s\S]*invoke\("begin_sensitive_display"\)[\s\S]*endSensitiveDisplay[\s\S]*invoke\("end_sensitive_display", \{ args: \{ token \} \}\)/,
    "renderer bridge must invoke both exact native lease commands",
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
    session,
    bridge,
    flow,
    onboarding,
    reveal,
  ] = await Promise.all([
    read("../plugins/tauri-plugin-zcash/android/src/main/java/ZcashPlugin.kt"),
    read("../plugins/tauri-plugin-zcash/ios/Sources/ZcashPlugin.swift"),
    read("../plugins/tauri-plugin-zcash/src/commands.rs"),
    read("../plugins/tauri-plugin-zcash/src/models.rs"),
    read("src/lib/wallet/sensitive-seed.ts"),
    read("src/lib/wallet/bridge.ts"),
    read("src/features/auth/useZcashChallengeFlow.ts"),
    read("src/features/wallet/Onboarding.tsx"),
    read("src/features/auth/SeedReveal.tsx"),
  ]);
  assertSeedCaptureBoundary({
    android,
    ios,
    rustCommands,
    models,
    session,
    bridge,
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
