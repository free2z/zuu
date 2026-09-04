import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

/**
 * The packaged CSP is the whole reason #813's `ERR0001` existed: ZUULI's
 * production policy allowed legacy Dyte origins and blocked the bundled
 * RealtimeKit SDK's very first request (#816), so "Join Free" failed before the
 * viewer ever initialized. This surface ships the SDK too, so it inherits that
 * hazard and must carry the same proof — with a *narrower* allowance than
 * ZUULI's, because every origin below is one this app can actually reach.
 *
 * Each admitted origin is justified in `REQUIRED_SOURCES`. Each origin ZUULI
 * allows that this app deliberately does NOT is justified in `REFUSED_SOURCES`,
 * and the second test proves those refusals do not break initialization — a
 * refusal nobody exercises is a refusal nobody can trust.
 */

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const tauriConfig = JSON.parse(
  readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
) as { app?: { security?: { csp?: unknown } } };
const productionCsp = tauriConfig.app?.security?.csp;

const apiOrigin = "https://api.realtime.cloudflare.com";
const participantDetailsUrl = `${apiOrigin}/v2/internals/participant-details`;

/**
 * Every RealtimeKit origin this app admits, and why. Nothing else from the SDK's
 * hostname table is allowed.
 */
const REQUIRED_SOURCES: Record<string, string> = {
  [apiOrigin]:
    "RealtimeKitClient.init()'s first call, /v2/internals/participant-details. " +
    "Blocking it is exactly the ERR0001 in #816; the negative control below reproduces it.",
  "https://rtk-assets.realtime.cloudflare.com":
    "@cloudflare/realtimekit-ui fetchEmojis() loads /assets/emojis-data.json for the " +
    "reactions picker inside <RtkMeeting>. It is not wrapped in try/catch, so a block " +
    "surfaces as an unhandled rejection rather than a degraded control.",
  "wss://socket-edge.realtime.cloudflare.com":
    "The meeting transport. SocketService.getSocketEdgeDomain() composes " +
    "`socket-edge.${baseURI}`; without it no media session is ever established.",
};

/**
 * Origins ZUULI's CSP allows that this surface refuses, and the evidence that
 * refusing them is safe. Recorded here so a future widening has to argue with a
 * specific claim instead of copying ZUULI's list wholesale.
 */
const REFUSED_SOURCES: Record<string, string> = {
  "https://location.realtime.cloudflare.com":
    "callstats IP lookup. The fetch is inside a try/catch whose catch only logs " +
    "'callstats::ipDetails:: failed to fetch ip using location service'. A content " +
    "app should not beacon the reader's IP to a third party to make a call statistic.",
  "https://location-legacy.realtime.cloudflare.com":
    "The legacy fallback for the same IP lookup, in the same try/catch.",
  "https://da-collector.realtime.cloudflare.com":
    "Device-analytics event collector (/api/v1/message). Best-effort: guarded by a " +
    "try/catch and a 3s AbortController timeout.",
  "https://api-silos.realtime.cloudflare.com":
    "OpenTelemetry log shipping (/otel/logs). Best-effort and caught.",
  "https://r2.cloudflarestorage.com":
    "Referenced nowhere in the installed dependency tree — `grep -rl cloudflarestorage " +
    "node_modules` returns zero files. ZUULI carries it speculatively.",
  "https://*.dyte.io":
    "Dead. RealtimeKit 1.5.1 throws 'Dyte Base URIs are no longer supported. Use " +
    "RealtimeKit Base URIs.' when the base URI contains dyte.io, so the bundled SDK " +
    "can never reach this origin.",
  "wss://*.dyte.io": "Dead, for the same reason as https://*.dyte.io.",
  "https://*.zec.rocks":
    "A lightwalletd origin. This app holds no seed and no spending key (#904); there " +
    "is nothing here that talks to a Zcash node.",
};

const expectedConnectSources = [
  "'self'",
  "https://free2z.cash",
  "https://*.free2z.cash",
  "https://free2z.com",
  "https://*.free2z.com",
  ...Object.keys(REQUIRED_SOURCES),
];

function directiveSources(csp: string, name: string): string[] {
  const directive = csp
    .split(";")
    .map((entry) => entry.trim().split(/\s+/u))
    .find(([candidate]) => candidate === name);
  return directive?.slice(1) ?? [];
}

function withoutSources(csp: string, drop: readonly string[]): string {
  return csp
    .split(";")
    .map((entry) => {
      const tokens = entry.trim().split(/\s+/u);
      return tokens[0] === "connect-src"
        ? tokens.filter((token) => !drop.includes(token)).join(" ")
        : tokens.join(" ");
    })
    .join("; ");
}

async function initializeWithCsp(page: Page, csp: string) {
  let requestCount = 0;
  await page.route(participantDetailsUrl, async (route) => {
    requestCount += 1;
    await route.fulfill({ status: 401, body: "" });
  });

  await page.goto("/");
  const bundlePath = `${appRoot}/node_modules/@cloudflare/realtimekit/dist/browser.js`;
  await page.setContent(`
    <!doctype html>
    <html>
      <head>
        <meta http-equiv="Content-Security-Policy" content="${csp}">
        <script src="/@fs/${bundlePath}"></script>
      </head>
      <body></body>
    </html>
  `);

  const result = await page.evaluate(async () => {
    const violations: Array<{
      blockedURI: string;
      violatedDirective: string;
    }> = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      violations.push({
        blockedURI: event.blockedURI,
        violatedDirective: event.violatedDirective,
      });
    });

    const encode = (value: object) =>
      btoa(JSON.stringify(value))
        .replaceAll("=", "")
        .replaceAll("+", "-")
        .replaceAll("/", "_");
    // A syntactically valid but entirely synthetic token. No real meeting id,
    // participant token or org secret ever enters this fixture (#816).
    const authToken = [
      encode({ alg: "none", typ: "JWT" }),
      encode({
        meetingId: crypto.randomUUID(),
        orgId: crypto.randomUUID(),
        participantId: crypto.randomUUID(),
      }),
      "synthetic",
    ].join(".");

    try {
      await RealtimeKitClient.init({ authToken });
      return { error: null, violations };
    } catch (error) {
      const candidate = error as {
        code?: unknown;
        message?: unknown;
        name?: unknown;
      };
      return {
        error: {
          code: typeof candidate.code === "string" ? candidate.code : null,
          message:
            typeof candidate.message === "string"
              ? candidate.message
              : String(error),
          name: typeof candidate.name === "string" ? candidate.name : null,
        },
        violations,
      };
    }
  });

  return { ...result, requestCount };
}

test("the packaged connect-src is exactly the reviewed source list", () => {
  expect(typeof productionCsp).toBe("string");
  expect(directiveSources(productionCsp as string, "connect-src")).toEqual(
    expectedConnectSources,
  );
});

test("no refused RealtimeKit origin has crept back into the packaged CSP", () => {
  const sources = directiveSources(productionCsp as string, "connect-src");
  for (const refused of Object.keys(REFUSED_SOURCES)) {
    expect(sources, `${refused}: ${REFUSED_SOURCES[refused]}`).not.toContain(
      refused,
    );
  }
});

test("Live needs no frames, no eval and no wasm", () => {
  const csp = productionCsp as string;
  // ZUULI ships the same SDK behind `frame-src 'none'`. RealtimeKit renders the
  // meeting as web components in-document, so admitting frames on the surface
  // that renders untrusted remote content would buy nothing (#367).
  expect(directiveSources(csp, "frame-src")).toEqual(["'none'"]);
  // ZUULI's `'wasm-unsafe-eval'` came from #535 (first-party Rust WASM), not
  // from RealtimeKit: `grep -rl WebAssembly` over the three @cloudflare
  // packages returns nothing.
  expect(directiveSources(csp, "script-src")).toEqual(["'self'"]);
  // The only `new Worker(...)` in the SDK is a `data:` URL inside
  // `EncryptionManager`, a separate entry point this app never imports
  // (`index.es.js` contains no Worker construction), so worker-src is left to
  // fall back to `default-src 'self'`.
  expect(directiveSources(csp, "worker-src")).toEqual([]);
});

test("production CSP admits the bundled RealtimeKit initialization request", async ({
  page,
}) => {
  const result = await initializeWithCsp(page, productionCsp as string);

  expect(result.requestCount).toBe(1);
  expect(result.violations).toEqual([]);
  // 0004/Unauthorized is the synthetic token being rejected by the mocked
  // endpoint: initialization got all the way to the server boundary.
  expect(result.error?.code).toBe("0004");
  expect(result.error?.message).toContain("Unauthorized");
});

test("removing the RealtimeKit API origin reproduces the ERR0001 CSP boundary", async ({
  page,
}) => {
  const csp = withoutSources(productionCsp as string, [apiOrigin]);
  expect(directiveSources(csp, "connect-src")).not.toContain(apiOrigin);

  const result = await initializeWithCsp(page, csp);

  expect(result.requestCount).toBe(0);
  expect(result.violations).toContainEqual({
    blockedURI: participantDetailsUrl,
    violatedDirective: "connect-src",
  });
  expect(result.error?.code).toBe("0001");
  expect(result.error?.message).toBe(
    "[ERR0001]: {Client} Failed to initialize.\nUnable to connect to the server. Check the internet connection.",
  );
});

declare global {
  const RealtimeKitClient: {
    init(options: { authToken: string }): Promise<unknown>;
  };
}
