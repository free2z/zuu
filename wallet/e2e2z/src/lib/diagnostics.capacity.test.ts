import { expect, it } from "vitest";
import { DiagnosticsStore, createEnvironment, MAX_PERSISTED_CHARACTERS, DIAGNOSTICS_SCHEMA_VERSION } from "@free2z/wallet-shared";

it("bounds hostile restored arrays and rejects oversized storage before parsing", () => {
  const environment = createEnvironment({ app: "e2e2z", version: "1.0.0", build: "1", userAgent: "" });
  let raw = "x".repeat(MAX_PERSISTED_CHARACTERS + 1);
  const persistence = { read: () => raw, write: (value: string) => { raw = value; }, clear: () => { raw = ""; } };
  expect(new DiagnosticsStore({ environment, persistence }).events()).toEqual([]);
  const frame = { fn: "fail", source: "https://private.invalid/assets/bundle.js?token=private", line: 1, column: 2 };
  raw = JSON.stringify({ v: DIAGNOSTICS_SCHEMA_VERSION, environment, events: [{ at: 1, kind: "reported-error", name: "Error", message: "Failed", frames: Array(50).fill(frame), breadcrumbs: Array(50).fill({ at: 1, category: "navigation", code: "route-enter" }) }] });
  const store = new DiagnosticsStore({ environment, persistence, eventCapacity: 1000, breadcrumbCapacity: 1000 });
  expect(store.events()[0]?.frames).toHaveLength(12);
  expect(store.events()[0]?.breadcrumbs).toHaveLength(12);
  expect(JSON.stringify(store.events())).not.toMatch(/private|token/);
  for (let i = 0; i < 200; i++) {
    store.breadcrumb("navigation", "route-enter");
    store.record("reported-error", new Error("Failed"));
  }
  expect(store.events().length).toBeLessThanOrEqual(40);
  expect(store.breadcrumbs()).toHaveLength(24);
  expect(raw.length).toBeLessThanOrEqual(MAX_PERSISTED_CHARACTERS);
});
