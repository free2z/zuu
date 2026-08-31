import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const tauriConfig = JSON.parse(
  readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
) as { app?: { security?: { csp?: unknown } } };
const productionCsp = tauriConfig.app?.security?.csp;

const apiOrigin = "https://api.realtime.cloudflare.com";
const participantDetailsUrl = `${apiOrigin}/v2/internals/participant-details`;
const requiredRealtimeKitSources = [
  apiOrigin,
  "https://api-silos.realtime.cloudflare.com",
  "https://da-collector.realtime.cloudflare.com",
  "https://location.realtime.cloudflare.com",
  "https://location-legacy.realtime.cloudflare.com",
  "https://r2.cloudflarestorage.com",
  "https://rtk-assets.realtime.cloudflare.com",
  "wss://socket-edge.realtime.cloudflare.com",
] as const;
const expectedConnectSources = [
  "'self'",
  "https://free2z.cash",
  "https://*.free2z.cash",
  "https://free2z.com",
  "https://*.free2z.com",
  "https://*.zec.rocks",
  "https://*.dyte.io",
  "wss://*.dyte.io",
  ...requiredRealtimeKitSources,
  "https://*.stripe.com",
  "https://checkout.stripe.com",
];

function directiveSources(csp: string, name: string): string[] {
  const directive = csp
    .split(";")
    .map((entry) => entry.trim().split(/\s+/u))
    .find(([candidate]) => candidate === name);
  return directive?.slice(1) ?? [];
}

function withoutRealtimeKitSources(csp: string): string {
  return csp
    .split(";")
    .map((entry) => {
      const tokens = entry.trim().split(/\s+/u);
      return tokens[0] === "connect-src"
        ? tokens
            .filter(
              (token) =>
                !requiredRealtimeKitSources.some((source) => source === token),
            )
            .join(" ")
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
          message: typeof candidate.message === "string" ? candidate.message : String(error),
          name: typeof candidate.name === "string" ? candidate.name : null,
        },
        violations,
      };
    }
  });

  return { ...result, requestCount };
}

test("production CSP admits the bundled RealtimeKit initialization request", async ({
  page,
}) => {
  expect(typeof productionCsp).toBe("string");
  const csp = productionCsp as string;
  expect(directiveSources(csp, "connect-src")).toEqual(
    expectedConnectSources,
  );

  const result = await initializeWithCsp(page, csp);

  expect(result.requestCount).toBe(1);
  expect(result.violations).toEqual([]);
  expect(result.error?.code).toBe("0004");
  expect(result.error?.message).toContain("Unauthorized");
});

test("removing the RealtimeKit sources reproduces the ERR0001 CSP boundary", async ({
  page,
}) => {
  expect(typeof productionCsp).toBe("string");
  const csp = withoutRealtimeKitSources(productionCsp as string);
  expect(directiveSources(csp, "connect-src")).not.toEqual(
    expect.arrayContaining([...requiredRealtimeKitSources]),
  );

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
