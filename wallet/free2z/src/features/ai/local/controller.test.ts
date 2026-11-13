// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { LocalDraftController, assertLocalPolicy, type Phase } from "./controller";
import type { Reply } from "./protocol";

class WorkerFixture {
  onmessage?: (event: MessageEvent<Reply>) => void;
  onerror?: (event: ErrorEvent) => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  emit(reply: Reply) { this.onmessage?.({ data: reply } as MessageEvent<Reply>); }
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function setup() {
  const worker = new WorkerFixture();
  const deleted = vi.fn(async () => true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ version: 1, enabled: true }))));
  vi.stubGlobal("caches", { delete: deleted });
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: vi.fn(async (_: unknown, __: unknown, callback: (lock: object) => Promise<void>) => callback({})) } });
  const updates: { phase: Phase; reply?: Reply }[] = [];
  const controller = new LocalDraftController((phase, reply) => updates.push({ phase, reply }), () => worker as unknown as Worker);
  return { controller, worker, deleted, updates };
}
it("fences late callbacks after cancellation and releases the owned worker/cache", async () => {
  const { controller, worker, deleted, updates } = setup();
  await controller.check();
  worker.emit({ kind: "supported", description: "fixture" });
  await controller.run({ kind: "load" });
  await controller.stop(true);
  const length = updates.length;
  worker.emit({ kind: "ready", metrics: { loadMs: 1 } });
  expect(updates).toHaveLength(length);
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(deleted).toHaveBeenCalledOnce();
  controller.dispose();
});
it("invalid reply/state fails closed instead of promoting to ready", async () => {
  const { controller, worker, updates } = setup();
  await controller.check();
  worker.emit({ kind: "done", metrics: {} });
  await vi.waitFor(() => expect(updates[updates.length - 1]?.phase).toBe("fallback"));
  expect(worker.terminate).toHaveBeenCalledOnce();
  controller.dispose();
});
it.each([{}, { version: 1, enabled: false }, { version: 2, enabled: true }, { version: 1, enabled: "true" }])("policy rejects %j", async (body) => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
  await expect(assertLocalPolicy()).rejects.toThrow("disabled remotely");
});

it("malformed worker data fails closed", async () => {
  const { controller, worker, updates } = setup();
  await controller.check();
  worker.emit(null as unknown as Reply);
  await vi.waitFor(() => expect(updates[updates.length - 1]?.phase).toBe("fallback"));
  expect(worker.terminate).toHaveBeenCalledOnce();
  controller.dispose();
});
