#!/usr/bin/env node
/**
 * The packaged Content-Security-Policy, as an exact directive contract.
 *
 * ZUULI is the wallet authority (#904): it holds the master seed and the
 * spending keys, and after phase 4 it renders no document, image, stylesheet
 * or SDK it did not author. Under #367 the CSP is one of the few containment
 * layers this app actually has — Wry injects Tauri's IPC bridge into every
 * frame on Android and reports the *top-level* URL as the origin, so a remote
 * subframe resolves as the trusted main window. Every origin the policy admits
 * and no longer needs is free surface on the signing authority.
 *
 * This file is the single source of truth for what the policy must be. It is
 * an exact match, not a subset check: a *widened* directive is the failure
 * mode that matters, and a "contains" assertion cannot see one.
 *
 * Run `node scripts/csp-policy.mjs` to check the committed config, and
 * `node scripts/csp-policy.mjs --self-test` to prove the checker rejects each
 * removal this policy exists to prevent.
 */

import { readFile } from "node:fs/promises";

/**
 * Per-directive justification. A directive with no entry here is a directive
 * nobody reviewed, and that fails.
 */
export const REVIEWED_DIRECTIVES = Object.freeze({
  "default-src": Object.freeze({
    sources: Object.freeze(["'self'"]),
    why: "Everything the app loads is bundled with the app.",
  }),
  "base-uri": Object.freeze({
    sources: Object.freeze(["'self'"]),
    why: "An injected <base> cannot re-root every relative URL in the app.",
  }),
  "object-src": Object.freeze({
    sources: Object.freeze(["'none'"]),
    why: "No plugin content, ever, in the process that holds the seed.",
  }),
  "worker-src": Object.freeze({
    sources: Object.freeze(["'none'"]),
    why: "The Mermaid render worker was the only worker and left with #904 phase 4.",
  }),
  "img-src": Object.freeze({
    sources: Object.freeze(["'self'", "data:"]),
    why:
      "Bundled art plus inlined data URIs. `https:` admitted any host on the " +
      "internet; `blob:` existed for RemoteMedia's validated local bytes. " +
      "Both left with the content surfaces — the app renders no remote image, " +
      "and `components/ui/avatar.tsx` no longer exports an image component.",
  }),
  "media-src": Object.freeze({
    sources: Object.freeze(["'none'"]),
    why: "Audio/video belonged to Markdown embeds and the live stage.",
  }),
  "frame-src": Object.freeze({
    sources: Object.freeze(["'none'"]),
    why: "#367: a remote subframe resolves as the trusted main window.",
  }),
  "connect-src": Object.freeze({
    sources: Object.freeze([
      "'self'",
      "https://free2z.cash",
      "https://*.free2z.cash",
    ]),
    why:
      "The free2z API for auth and 2Z balances, matching the `http:default` " +
      "capability's URL allowlist. lightwalletd (`*.zec.rocks`) is reached " +
      "from Rust by tauri-plugin-zcash and was never a WebView connection; " +
      "Stripe Checkout is opened in the OS browser by tauri-plugin-opener, " +
      "not fetched; RealtimeKit and `*.dyte.io` left with Live (#921 — " +
      "RealtimeKit 1.5.1 throws on a dyte.io base URI, so those two origins " +
      "were already dead).",
  }),
  "style-src": Object.freeze({
    sources: Object.freeze(["'self'", "'unsafe-inline'"]),
    why:
      "Radix primitives set inline styles for positioning. Removing this is " +
      "its own change and needs a nonce pipeline Tauri does not give us.",
  }),
  "script-src": Object.freeze({
    sources: Object.freeze(["'self'", "'wasm-unsafe-eval'"]),
    why:
      "`'wasm-unsafe-eval'` is still load-bearing: `src/lib/wasm-spike.ts` " +
      "instantiates the first-party Rust/WASM module (#535), and " +
      "`scripts/wasm-boundary.mjs` pins this exact string.",
  }),
});

/** Origins the policy used to admit and must never admit again. */
export const RETIRED_SOURCES = Object.freeze([
  "https:",
  "blob:",
  "https://free2z.com",
  "https://*.free2z.com",
  "https://*.zec.rocks",
  "https://*.dyte.io",
  "wss://*.dyte.io",
  "https://api.realtime.cloudflare.com",
  "https://api-silos.realtime.cloudflare.com",
  "https://da-collector.realtime.cloudflare.com",
  "https://location.realtime.cloudflare.com",
  "https://location-legacy.realtime.cloudflare.com",
  "https://r2.cloudflarestorage.com",
  "https://rtk-assets.realtime.cloudflare.com",
  "wss://socket-edge.realtime.cloudflare.com",
  "https://*.stripe.com",
  "https://checkout.stripe.com",
]);

/** Parse a policy string into `{ directive: [source, ...] }`. */
export function parseCsp(csp) {
  if (typeof csp !== "string" || csp.trim() === "") {
    throw new Error("packaged Tauri CSP must be a non-empty string");
  }
  const directives = new Map();
  for (const entry of csp.split(";")) {
    const tokens = entry.trim().split(/\s+/u).filter(Boolean);
    if (tokens.length === 0) continue;
    const [name, ...sources] = tokens;
    if (directives.has(name)) {
      throw new Error(`packaged CSP repeats the ${name} directive`);
    }
    directives.set(name, sources);
  }
  return directives;
}

export function assertCspPolicy(csp) {
  const directives = parseCsp(csp);

  const declared = [...directives.keys()].sort();
  const reviewed = Object.keys(REVIEWED_DIRECTIVES).sort();
  if (declared.join(" ") !== reviewed.join(" ")) {
    throw new Error(
      `packaged CSP directive set differs from the reviewed set;\n  declared=${declared.join(", ")}\n  reviewed=${reviewed.join(", ")}`,
    );
  }

  for (const [name, contract] of Object.entries(REVIEWED_DIRECTIVES)) {
    const actual = directives.get(name) ?? [];
    if (actual.join(" ") !== contract.sources.join(" ")) {
      throw new Error(
        `packaged CSP ${name} differs from the reviewed sources;\n  declared=${actual.join(" ")}\n  reviewed=${contract.sources.join(" ")}\n  why: ${contract.why}`,
      );
    }
  }

  // Belt and braces: the exact-set check above already catches a re-added
  // origin, but naming the retired ones makes the failure say *what* came back.
  for (const [name, sources] of directives) {
    for (const source of sources) {
      if (RETIRED_SOURCES.includes(source)) {
        throw new Error(
          `packaged CSP ${name} re-admits the retired source ${source}`,
        );
      }
    }
  }
}

async function packagedCsp() {
  const config = JSON.parse(
    await readFile(
      new URL("../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ),
  );
  return config?.app?.security?.csp;
}

/**
 * The mutations this checker exists to catch. Each one is a real regression
 * shape: a widened directive, a re-added dead origin, or a lost restriction.
 */
const SELF_TEST_MUTATIONS = Object.freeze([
  ["img-src re-admits every HTTPS host", "img-src 'self' data:", "img-src 'self' data: https:"],
  ["img-src re-admits blob URLs", "img-src 'self' data:", "img-src 'self' data: blob:"],
  ["media-src is reopened", "media-src 'none'", "media-src 'self' https:"],
  ["frame-src is reopened", "frame-src 'none'", "frame-src 'self'"],
  ["object-src is reopened", "object-src 'none'", "object-src 'self'"],
  ["worker-src is reopened", "worker-src 'none'", "worker-src 'self'"],
  [
    "connect-src re-admits the dead dyte.io origins (#921)",
    "connect-src 'self' https://free2z.cash",
    "connect-src 'self' https://*.dyte.io wss://*.dyte.io https://free2z.cash",
  ],
  [
    "connect-src re-admits lightwalletd, which the WebView never calls",
    "connect-src 'self' https://free2z.cash",
    "connect-src 'self' https://*.zec.rocks https://free2z.cash",
  ],
  [
    "connect-src re-admits the RealtimeKit signalling origins",
    "connect-src 'self' https://free2z.cash",
    "connect-src 'self' https://api.realtime.cloudflare.com https://free2z.cash",
  ],
  ["base-uri is dropped", "base-uri 'self'; ", ""],
  ["script-src loses the WASM grant", "'wasm-unsafe-eval'", "'strict-dynamic'"],
  ["script-src gains eval", "script-src 'self' 'wasm-unsafe-eval'", "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'"],
]);

async function selfTest(csp) {
  let failures = 0;
  for (const [name, from, to] of SELF_TEST_MUTATIONS) {
    if (!csp.includes(from)) {
      console.error(`self-test mutation is stale, ${from} is not in the CSP: ${name}`);
      failures += 1;
      continue;
    }
    const mutant = csp.replace(from, to);
    if (mutant === csp) {
      console.error(`self-test mutation did not apply: ${name}`);
      failures += 1;
      continue;
    }
    let rejected = false;
    try {
      assertCspPolicy(mutant);
    } catch {
      rejected = true;
    }
    if (!rejected) {
      console.error(`self-test mutation was NOT rejected: ${name}`);
      failures += 1;
    }
  }
  if (failures > 0) {
    throw new Error(`${failures} CSP self-test mutation(s) went undetected`);
  }
  console.log(
    `CSP self-test: ${SELF_TEST_MUTATIONS.length} mutations rejected.`,
  );
}

export async function main(argv = process.argv.slice(2)) {
  const csp = await packagedCsp();
  assertCspPolicy(csp);
  if (argv.includes("--self-test")) await selfTest(csp);
  console.log("Packaged CSP matches the reviewed directive contract.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
