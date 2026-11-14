import type { BrowserContext, Page } from "@playwright/test";

// Context init scripts run before document scripts in pages and child frames.
// Workers are deliberately unsupported: document init scripts do not run there.
function denyStatefulTransports() {
  const report = (
    globalThis as unknown as {
      __nullProbeBlocked: (kind: string) => Promise<void>;
    }
  ).__nullProbeBlocked;
  const blocked = (kind: string) => {
    void report(kind);
    throw new DOMException(
      "Transport unsupported by this probe",
      "NotAllowedError",
    );
  };
  try {
    for (const name of [
      "WebSocket",
      "WebSocketStream",
      "WebTransport",
      "RTCPeerConnection",
      "webkitRTCPeerConnection",
      "Worker",
      "SharedWorker",
      "EventSource",
    ]) {
      if (
        typeof (globalThis as unknown as Record<string, unknown>)[name] !==
        "function"
      )
        continue;
      Object.defineProperty(globalThis, name, {
        value: function () {
          return blocked(name);
        },
        writable: false,
        configurable: false,
      });
    }
    Object.defineProperty(navigator, "sendBeacon", {
      value: () => {
        void report("sendBeacon");
        return false;
      },
      writable: false,
      configurable: false,
    });
    if (typeof ServiceWorkerContainer !== "undefined")
      Object.defineProperty(ServiceWorkerContainer.prototype, "register", {
        value: () => {
          void report("serviceWorker");
          return Promise.reject(
            new DOMException(
              "Workers unsupported by this probe",
              "NotAllowedError",
            ),
          );
        },
        writable: false,
        configurable: false,
      });
    Object.defineProperty(globalThis, "__nullProbePolicyReady", {
      value: true,
      configurable: false,
      writable: false,
    });
  } catch {
    void report("unsupported-policy");
  }
}

export async function installReadOnlyProbePolicy(context: BrowserContext) {
  const blockedTransports: Record<string, number> = {};
  // Fail before visiting a target if this installed Playwright lacks WS routing.
  if (typeof context.routeWebSocket !== "function")
    throw new Error("Unsupported transport interception");
  await context.exposeBinding("__nullProbeBlocked", (_source, kind: string) => {
    const allowed = [
      "WebSocket",
      "WebSocketStream",
      "WebTransport",
      "RTCPeerConnection",
      "webkitRTCPeerConnection",
      "Worker",
      "SharedWorker",
      "EventSource",
      "sendBeacon",
      "serviceWorker",
      "unsupported-policy",
    ];
    const category = allowed.includes(kind) ? kind : "unsupported-policy";
    blockedTransports[category] = (blockedTransports[category] || 0) + 1;
  });
  // Never connectToServer: native WebSockets, including an attempted bypass of
  // the document guard, cannot open a connection or send a frame to the server.
  await context.routeWebSocket(/.*/, async (socket) => {
    blockedTransports.WebSocketRoute =
      (blockedTransports.WebSocketRoute || 0) + 1;
    await socket.close();
  });
  await context.addInitScript(denyStatefulTransports);
  return blockedTransports;
}

export async function assertProbePolicyReady(page: Page) {
  if (
    !(await page.evaluate(
      () =>
        (globalThis as unknown as { __nullProbePolicyReady?: boolean })
          .__nullProbePolicyReady === true,
    ))
  )
    throw new Error("Transport guard unavailable");
}

export type ProbeReadiness = { selector: string; trigger?: string };

/** A static SSR node cannot prove hydration; require a newly visible node. */
export async function waitForProbeReadiness(
  page: Page,
  signal: ProbeReadiness,
  timeout: number,
) {
  const expires = Date.now() + timeout;
  const remaining = () => {
    const ms = expires - Date.now();
    if (ms <= 0) throw new Error("Client readiness deadline exceeded");
    return ms;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const steps = async () => {
    if (signal.trigger) {
      const trigger = page.locator(signal.trigger);
      await trigger.waitFor({ state: "visible", timeout: remaining() });
      if (
        !(await trigger.evaluate(
          (node) => node instanceof HTMLButtonElement && node.type === "button",
        ))
      )
        throw new Error("Readiness trigger must be a non-submit button");
      await trigger.click({ timeout: remaining() });
    }
    await page
      .locator(signal.selector)
      .waitFor({ state: "visible", timeout: remaining() });
  };
  try {
    await Promise.race([
      steps(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Client readiness deadline exceeded")),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
