// @vitest-environment jsdom
import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DiagnosticsPersistence,
  DiagnosticsStore,
  bootstrapReporter,
  boundaryReporter,
  createEnvironment,
  installGlobalDiagnostics,
  localStoragePersistence,
  renderDiagnosticsReport,
} from "@free2z/wallet-shared";
import { ErrorBoundary } from "../components/common/ErrorBoundary";
import { mountApplication, RootFallback } from "../app-bootstrap";

/**
 * That the three ways this app can fail each leave a record.
 *
 * The one that matters is the rejection. #973 was not an exotic bug: a promise
 * rejected, a `void` discarded it, and the process had no listener — so the app
 * hung on a skeleton and produced no evidence at all. These tests are the proof
 * that the listener now exists and writes something a person can read.
 */

const ENVIRONMENT = createEnvironment({
  app: "e2e2z",
  version: "0.1.0",
  build: "2",
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
});

function newStore(persistence: DiagnosticsPersistence | null = null) {
  return new DiagnosticsStore({ environment: ENVIRONMENT, persistence });
}

let uninstall: (() => void) | null = null;

afterEach(() => {
  uninstall?.();
  uninstall = null;
  vi.restoreAllMocks();
});

describe("a rejected promise produces a record", () => {
  it("captures the reason an unhandled rejection carried", () => {
    const store = newStore();
    uninstall = installGlobalDiagnostics(store, window);

    const event = new Event("unhandledrejection");
    Object.defineProperty(event, "reason", {
      value: new Error("getEngineStatus is not a function"),
    });
    window.dispatchEvent(event);

    expect(store.events()).toHaveLength(1);
    expect(store.events()[0]?.kind).toBe("unhandled-rejection");
    expect(store.events()[0]?.name).toBe("Error");
    expect(store.events()[0]?.message).toBe(
      "getEngineStatus is not a function",
    );
  });

  it("stops capturing once uninstalled", () => {
    const store = newStore();
    installGlobalDiagnostics(store, window)();
    const event = new Event("unhandledrejection");
    Object.defineProperty(event, "reason", { value: new Error("late") });
    window.dispatchEvent(event);
    expect(store.events()).toHaveLength(0);
  });
});

describe("an uncaught error produces a record", () => {
  it("prefers the thrown error over the event's own message", () => {
    const store = newStore();
    uninstall = installGlobalDiagnostics(store, window);

    const event = new Event("error");
    Object.defineProperty(event, "error", {
      value: new TypeError("cannot read properties of undefined"),
    });
    Object.defineProperty(event, "message", { value: "Script error." });
    window.dispatchEvent(event);

    expect(store.events()[0]?.kind).toBe("uncaught-error");
    expect(store.events()[0]?.name).toBe("TypeError");
  });

  it("still records a cross-origin script error, which carries no error", () => {
    const store = newStore();
    uninstall = installGlobalDiagnostics(store, window);
    const event = new Event("error");
    Object.defineProperty(event, "message", { value: "Script error." });
    window.dispatchEvent(event);
    expect(store.events()[0]?.name).toBe("ErrorEvent");
  });
});

describe("a render throw produces a record", () => {
  it("is captured by the root boundary rather than only degraded", () => {
    const store = newStore();
    const container = document.createElement("div");
    document.body.append(container);
    // React logs the caught error; the test is about the record, not the noise.
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    function Exploding(): JSX.Element {
      throw new Error("the transcript could not render");
    }

    const root = createRoot(container);
    act(() => {
      root.render(
        <StrictMode>
          <ErrorBoundary
            fallback={<p>fallback</p>}
            onError={boundaryReporter(store)}
          >
            <Exploding />
          </ErrorBoundary>
        </StrictMode>,
      );
    });

    expect(container.textContent).toContain("fallback");
    expect(store.events()).toHaveLength(1);
    expect(store.events()[0]?.kind).toBe("render-error");
    expect(store.events()[0]?.message).toBe(
      "the transcript could not render",
    );
    act(() => root.unmount());
    container.remove();
  });
});

describe("a bootstrap failure produces a record", () => {
  it("records why the recovery frame is on screen", async () => {
    const store = newStore();
    const rendered: string[] = [];

    await mountApplication({
      root: {
        render(children) {
          rendered.push(renderToStaticMarkup(children));
        },
      },
      initializeI18n: async () => {
        throw new Error("catalog chunk unavailable");
      },
      renderApplication: () => <p>never</p>,
      reportError: bootstrapReporter(store),
    });

    expect(rendered[0]).toContain("Something went wrong");
    expect(store.events()[0]?.kind).toBe("bootstrap-error");
    expect(store.events()[0]?.message).toBe("catalog chunk unavailable");
  });

  it("still renders the recovery frame it always did", () => {
    expect(renderToStaticMarkup(<RootFallback />)).toContain('role="alert"');
  });
});

describe("the buffer is bounded and survives a restart", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("keeps the newest events and drops the oldest", () => {
    const store = new DiagnosticsStore({
      environment: ENVIRONMENT,
      persistence: null,
      eventCapacity: 3,
    });
    for (const index of [1, 2, 3, 4, 5]) {
      store.record("reported-error", new Error(`failure ${index}`));
    }
    expect(store.events()).toHaveLength(3);
    expect(store.events()[0]?.message).toBe("failure 3");
    expect(store.events()[2]?.message).toBe("failure 5");
  });

  it("reads back what the previous run wrote", () => {
    const first = newStore(localStoragePersistence(window.localStorage));
    first.breadcrumb("messaging", "engine-status-requested");
    first.record("unhandled-rejection", new Error("engine unreachable"));

    const second = newStore(localStoragePersistence(window.localStorage));
    expect(second.events()).toHaveLength(1);
    expect(second.events()[0]?.message).toBe("engine unreachable");
    expect(second.events()[0]?.breadcrumbs[0]?.code).toBe(
      "engine-status-requested",
    );
  });

  it("ignores a buffer another surface wrote", () => {
    const zuuli = new DiagnosticsStore({
      environment: createEnvironment({
        app: "zuuli",
        version: "0.1.0",
        build: "20",
        userAgent: "",
      }),
      persistence: localStoragePersistence(window.localStorage),
    });
    zuuli.record("reported-error", new Error("not this app"));

    const mine = newStore(localStoragePersistence(window.localStorage));
    expect(mine.events()).toHaveLength(0);
  });

  it("captures in memory when storage is unavailable", () => {
    const throwing = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
      removeItem() {
        throw new Error("blocked");
      },
    };
    const store = newStore(localStoragePersistence(throwing));
    expect(() =>
      store.record("reported-error", new Error("still recorded")),
    ).not.toThrow();
    expect(store.events()).toHaveLength(1);
  });
});

describe("the exported report", () => {
  it("names the build and the failure and says nothing left the device", () => {
    const store = newStore();
    store.breadcrumb("lifecycle", "app-start");
    store.record("unhandled-rejection", new Error("engine unreachable"));
    const report = renderDiagnosticsReport(store, { at: 1_757_000_000_000 });

    expect(report).toContain("### Diagnostics report");
    expect(report).toContain("| app | e2e2z |");
    expect(report).toContain("| version | 0.1.0 (2) |");
    expect(report).toContain("| platform | ios 18.0 |");
    expect(report).toContain("| engine | webkit |");
    expect(report).toContain("unhandled-rejection");
    expect(report).toContain("engine unreachable");
    expect(report).toContain("lifecycle/app-start");
    expect(report).toContain("nothing here left the device");
  });

  it("says so plainly when there is nothing to report", () => {
    expect(renderDiagnosticsReport(newStore())).toContain(
      "No failures have been recorded on this device.",
    );
  });
});
