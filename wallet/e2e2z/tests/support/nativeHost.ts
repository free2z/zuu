// A stand-in for e2e2z's native side, for the unmocked build.
//
// The default build (no `VITE_MOCK`) is what a packaged e2e2z ships, so the
// specs that prove deep links and enrollment run against it, with this
// installed as `window.__TAURI_INTERNALS__`. It answers the commands the app
// really registers — `tauri-plugin-f2zmsg`'s, the `e2e2z_*` app-crate ones,
// the deep-link plugin's and the event plugin's — and throws "not found" for
// everything else, the way a Tauri host does.
//
// `window.__HOST__` is the test's handle on it: what was invoked, the state it
// answers with, and `openUrl`/`answerIntent` to play the operating system and
// ZUULI.

import type { Page } from "@playwright/test";

export const IPHONE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

export interface HostEngine {
  state: string;
  enrolled: boolean;
  handle: string | null;
  relaysConnected: number;
  relaysConfigured: number;
  witnessThresholdMet: boolean;
  independentWitnesses: number;
  pendingInbound: number;
  unacknowledgedAlarms: number;
  lastError: string | null;
  /** ADR 0017 §3; absent in a build older than the field. */
  directoryBlocked?: string | null;
}

export interface HostEnrollment {
  enrolled: boolean;
  handle: string | null;
  eligibility: {
    eligible: boolean;
    candidate: string | null;
    reason: string | null;
  };
  directoryEntryVersion: number | null;
  submittedAt: number | null;
  mergedAtEpoch: number | null;
  blocked: string | null;
}

export interface HostOptions {
  engine?: Partial<HostEngine>;
  enrollment?: Partial<HostEnrollment>;
  /** URLs `getCurrent` answers: the link that launched the app. */
  launchUrls?: string[] | null;
  /** A bare §8 code `e2e2z_device_credential_keys` refuses with. */
  keysError?: string | null;
  /** A bare §8 code the install refuses with, or null to accept. */
  installError?: string | null;
  /** A code `e2e2z_dispatch_intent` refuses with. */
  dispatchError?: string | null;
  /** When the handle is active, `mergedAtEpoch` after an install. */
  mergeOnInstall?: boolean;
}

export const ENGINE_STOPPED: HostEngine = {
  state: "stopped",
  enrolled: false,
  handle: null,
  relaysConnected: 0,
  relaysConfigured: 1,
  witnessThresholdMet: false,
  independentWitnesses: 1,
  pendingInbound: 0,
  unacknowledgedAlarms: 0,
  lastError: null,
  directoryBlocked: null,
};

export const NOT_ENROLLED: HostEnrollment = {
  enrolled: false,
  handle: null,
  eligibility: { eligible: false, candidate: null, reason: "not-signed-in" },
  directoryEntryVersion: null,
  submittedAt: null,
  mergedAtEpoch: null,
  blocked: null,
};

export const ACTIVE_ENROLLMENT: HostEnrollment = {
  enrolled: true,
  handle: "self",
  eligibility: { eligible: true, candidate: "self", reason: null },
  directoryEntryVersion: 1,
  submittedAt: 1,
  mergedAtEpoch: 7,
  blocked: null,
};

/** The port the second `webServer` in playwright.config.ts serves. */
export function unmockedBaseUrl(baseURL: string | undefined): string {
  const url = new URL(baseURL ?? "http://127.0.0.1:1437");
  url.port = String(Number(url.port) + 1);
  return url.toString();
}

export async function installNativeHost(
  page: Page,
  options: HostOptions = {},
): Promise<void> {
  await page.addInitScript(
    ({ options, engine, enrollment }) => {
      type Handler = number;
      const handlers = new Map<string, Handler[]>();
      let nextCallback = 1;
      const host = {
        invoked: [] as string[],
        dispatched: [] as string[],
        installs: [] as Array<Record<string, unknown>>,
        engine: { ...engine, ...(options.engine ?? {}) },
        enrollment: { ...enrollment, ...(options.enrollment ?? {}) },
        options,
        /** Play the OS delivering a link to this app. */
        openUrl(url: string) {
          for (const id of handlers.get("deep-link://new-url") ?? []) {
            const fn = (window as unknown as Record<string, unknown>)[`_${id}`];
            if (typeof fn === "function") {
              (fn as (event: unknown) => void)({
                event: "deep-link://new-url",
                id,
                payload: [url],
              });
            }
          }
        },
        /**
         * Play ZUULI answering the last dispatched request.
         * `status` 0 carries a credential; any other status carries nothing.
         */
        answerIntent(status: number) {
          const request = host.dispatched[host.dispatched.length - 1];
          if (!request) throw new Error("nothing was dispatched");
          // version(2) + length(3) + intent(2), then the 32-byte request id.
          // The family is **echoed from the request** rather than assumed: a
          // client refuses an answer to a question it did not ask, so a host
          // that hard-coded one would stop being a stand-in the day a new
          // payload version shipped (ADR 0017 §4.1).
          const family = request.slice(10, 14);
          const requestId = request.slice(14, 14 + 64);
          const hex = (value: number, bytes: number) =>
            value.toString(16).padStart(bytes * 2, "0");
          const payload = status === 0 ? hex(4, 3) + "c0ffee00" : "";
          const body =
            requestId + family + hex(status, 2) + hex(payload.length / 2, 3) + payload;
          const response = hex(1, 2) + hex(body.length / 2, 3) + body;
          host.openUrl(
            `https://free2z.com/bridge/e2e2z/#res=${response}&rid=${requestId}`,
          );
        },
        /**
         * Play the log merging this device's entry at `epoch`.
         *
         * The real path is `e2e2z_enrollment_status`, which asks the engine to
         * resolve this handle against a witness-cosigned root while it is not
         * yet merged (ADR 0017 §6). What the screen must do with that answer is
         * this host's subject.
         */
        mergeAt(epoch: number) {
          host.enrollment = {
            ...host.enrollment,
            mergedAtEpoch: epoch,
            directoryEntryVersion: 1,
            blocked: null,
          };
        },
      };
      (window as unknown as { __HOST__: typeof host }).__HOST__ = host;

      const eligibility = (username: string) => {
        if (username === "") {
          return { eligible: false, candidate: null, reason: "punctuation" };
        }
        if (!/^[\x00-\x7f]*$/.test(username)) {
          return { eligible: false, candidate: null, reason: "non-ascii" };
        }
        const candidate = username.toLowerCase();
        if (!/^[a-z0-9_]*$/.test(candidate)) {
          return { eligible: false, candidate: null, reason: "punctuation" };
        }
        if (candidate.length > 30) {
          return { eligible: false, candidate: null, reason: "too-long" };
        }
        return { eligible: true, candidate, reason: null };
      };

      (
        window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> }
      ).__TAURI_INTERNALS__ = {
        transformCallback(callback: unknown, once: boolean) {
          const id = nextCallback++;
          const key = `_${id}`;
          Object.defineProperty(window, key, {
            value: (...args: unknown[]) => {
              if (once) Reflect.deleteProperty(window, key);
              return (callback as (...a: unknown[]) => unknown)(...args);
            },
            writable: false,
            configurable: true,
          });
          return id;
        },
        unregisterCallback(id: number) {
          Reflect.deleteProperty(window, `_${id}`);
        },
        async invoke(cmd: string, args: Record<string, unknown> | undefined) {
          host.invoked.push(cmd);
          const inner = (args?.["args"] ?? {}) as Record<string, unknown>;
          switch (cmd) {
            case "plugin:event|listen": {
              const event = String(args?.["event"]);
              const list = handlers.get(event) ?? [];
              list.push(args?.["handler"] as number);
              handlers.set(event, list);
              return nextCallback++;
            }
            case "plugin:event|unlisten":
              return null;
            case "plugin:deep-link|get_current":
              return host.options.launchUrls ?? null;
            case "plugin:f2zmsg|get_engine_status":
              return host.engine;
            case "plugin:f2zmsg|get_device_info":
              // What an unenrolled engine answers: the bare §8 code.
              throw "not-enrolled";
            case "plugin:f2zmsg|check_handle_eligibility":
              return eligibility(String(inner["username"] ?? ""));
            case "plugin:f2zmsg|list_conversations":
              return { conversations: [], nextCursor: null };
            case "plugin:f2zmsg|list_contact_requests":
              return [];
            case "e2e2z_enrollment_status":
              return host.enrollment;
            case "e2e2z_device_credential_keys":
              if (host.options.keysError) throw host.options.keysError;
              return {
                devicePk: "ab".repeat(32),
                deviceKemPk: "22".repeat(1216),
                // ADR 0017 §4.1: the command opens the contact queue before it
                // answers, so the request can carry the endpoint.
                contactRelayUrl: "wss://relay.free2z.com/relay/v1",
                contactRelayId: "33".repeat(32),
                contactAddr: "44".repeat(32),
              };
            case "e2e2z_dispatch_intent":
              if (host.options.dispatchError) throw host.options.dispatchError;
              host.dispatched.push(String(inner["request"]));
              return null;
            case "e2e2z_install_device_credential": {
              host.installs.push(inner);
              if (host.options.installError) throw host.options.installError;
              const handle = String(inner["expectedHandle"]);
              host.enrollment = {
                enrolled: true,
                handle,
                eligibility: { eligible: true, candidate: handle, reason: null },
                directoryEntryVersion: null,
                submittedAt: 1,
                mergedAtEpoch: host.options.mergeOnInstall ? 9 : null,
                blocked: host.options.mergeOnInstall ? null : "directory-unreachable",
              };
              host.engine = { ...host.engine, state: "enrolling", enrolled: true, handle };
              return host.enrollment;
            }
            default:
              throw new Error(`Command ${cmd} not found`);
          }
        },
      };
    },
    { options, engine: ENGINE_STOPPED, enrollment: NOT_ENROLLED },
  );
}

/** Play the log merging this device's entry, then let the screen re-read. */
export async function mergeAt(page: Page, epoch: number): Promise<void> {
  await page.evaluate(
    (value) =>
      (
        window as unknown as { __HOST__: { mergeAt(epoch: number): void } }
      ).__HOST__.mergeAt(value),
    epoch,
  );
}

/** What the host saw, read back from the page. */
export async function hostRecord(page: Page): Promise<{
  invoked: string[];
  dispatched: string[];
  installs: Array<Record<string, unknown>>;
}> {
  return page.evaluate(() => {
    const host = (
      window as unknown as {
        __HOST__: {
          invoked: string[];
          dispatched: string[];
          installs: Array<Record<string, unknown>>;
        };
      }
    ).__HOST__;
    return {
      invoked: [...host.invoked],
      dispatched: [...host.dispatched],
      installs: [...host.installs],
    };
  });
}
