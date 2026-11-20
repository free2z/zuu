/// <reference types="@webgpu/types" />
import type { MLCEngine } from "@mlc-ai/web-llm";
import manifest from "./artifacts.json";
import { artifactStore } from "./artifact-cache";
import { MAX_PROMPT, type Command, type Reply } from "./protocol";

const send = (reply: Reply) => postMessage(reply);
const store = artifactStore(globalThis.caches, globalThis.fetch.bind(globalThis));
let engine: MLCEngine | undefined;
let state: "new" | "supported" | "ready" | "failed" = "new";
let busy = false;
let stage = "capability check";

// WebLLM 0.2.88 uses CacheStorage.open().match()/add() and fetch().
// Give the runtime a read-only, verified view of our cache, including shards.
// It cannot create a second persistent cache or fetch anything from a prompt.
const urlOf = (input: RequestInfo | URL) => typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
Object.defineProperty(globalThis, "caches", { value: {
  open: async (name: string) => {
    if (!["webllm/config", "webllm/wasm", "webllm/model"].includes(name)) throw new Error("Unexpected runtime cache");
    return { keys: () => store.keys(), match: (input: RequestInfo | URL) => store.read(urlOf(input)), add: async () => { throw new Error("Runtime download blocked"); } };
  },
} });
globalThis.fetch = async (input, init) => {
  if ((init?.method ?? (input instanceof Request ? input.method : "GET")) !== "GET" || init?.body) throw new Error("Runtime network blocked");
  return store.read(urlOf(input));
};

async function probe() {
  if (!globalThis.isSecureContext || !navigator.gpu) throw new Error("WebGPU unavailable in this browser or context");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter available");
  if (adapter.limits.maxStorageBufferBindingSize < 128 * 1024 * 1024) throw new Error("WebGPU buffer limit too small");
  const device = await adapter.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: 128 * 1024 * 1024 } });
  device.destroy();
  return `${adapter.info.vendor || "Unidentified vendor"} / ${adapter.info.description || "WebGPU adapter"}. Device creation succeeded; generation still needs evaluation.`;
}

onmessage = async (event: MessageEvent<Command>) => {
  if (busy || state === "failed") return;
  busy = true;
  try {
    const command = event.data;
    if (command.kind === "probe" && state === "new") {
      const description = await probe();
      state = "supported";
      send({ kind: "supported", description });
    } else if (command.kind === "load" && state === "supported") {
      const started = performance.now();
      await probe();
      stage = "artifact download/verification";
      await store.prepare((text) => send({ kind: "progress", text }));
      stage = "runtime import";
      const { MLCEngine } = await import("@mlc-ai/web-llm");
      engine = new MLCEngine({
        logLevel: "SILENT",
        appConfig: { cacheBackend: "cache", model_list: [{ model_id: manifest.model, model: manifest.base,
          model_lib: manifest.library, overrides: { context_window_size: 1024 } }] },
        initProgressCallback: ({ progress }) => send({ kind: "progress", text: `Loading runtime ${Math.round(progress * 100)}%` }),
      });
      stage = "WebGPU model load";
      await engine.reload(manifest.model);
      state = "ready";
      send({ kind: "ready", metrics: { loadMs: performance.now() - started } });
    } else if (command.kind === "generate" && state === "ready" && engine) {
      if (typeof command.prompt !== "string" || !command.prompt.trim() || command.prompt.length > MAX_PROMPT) throw new Error("Prompt must contain 1–2000 characters");
      stage = "local generation";
      const started = performance.now();
      // Cache eviction is recoverable only by another explicit download choice.
      for (const file of manifest.files) await store.read(file.url);
      await engine.resetChat();
      let firstTokenMs: number | null = null;
      let text = "";
      const chunks = await engine.chat.completions.create({
        messages: [{ role: "user", content: command.prompt }], stream: true,
        max_tokens: 32, temperature: 0, seed: 1295,
      });
      for await (const chunk of chunks) {
        const delta = chunk.choices[0]?.delta.content;
        if (delta) {
          firstTokenMs ??= performance.now() - started;
          text += delta;
          send({ kind: "token", text });
        }
      }
      await engine.resetChat();
      send({ kind: "done", metrics: { firstTokenMs, finishedMs: performance.now() - started } });
    } else { throw new Error("Invalid local runtime state"); }
  } catch (error) {
    state = "failed";
    // Never serialize/log the prompt or a runtime error that might quote it.
    const reason = error instanceof Error && /^(WebGPU|No WebGPU|Model |Partial model|Artifact |Untrusted artifact|Runtime |Invalid local|Prompt must)/.test(error.message)
      ? error.message : `Browser runtime failed during ${stage} (${error instanceof Error && /^[A-Za-z]+$/.test(error.name) ? error.name : "Error"}). No server request was made.`;
    send({ kind: "failed", reason });
  } finally { busy = false; }
};
