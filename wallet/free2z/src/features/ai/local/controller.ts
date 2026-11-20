import { CACHE, POLICY, MAX_PROMPT, isReply, type Command, type Reply } from "./protocol";

export async function assertLocalPolicy(signal?: AbortSignal) {
  const response = await fetch(POLICY, { cache: "no-store", credentials: "omit", redirect: "error", signal });
  if (!response.ok) throw new Error("Local mode policy unavailable");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("enabled" in value) || value.enabled !== true) {
    throw new Error("Local mode disabled remotely");
  }
}

export type Phase = "idle" | "checking" | "supported" | "loading" | "ready" | "generating" | "stopping" | "fallback";
export class LocalDraftController {
  private worker?: Worker;
  private epoch = 0;
  private phase: Phase = "idle";
  private release?: () => void;
  private policyAbort?: AbortController;
  private deadline?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private poll?: ReturnType<typeof setInterval>;
  private probingPolicy = false;
  private stopPromise?: Promise<void>;
  constructor(private update: (phase: Phase, reply?: Reply) => void,
    private createWorker = () => new Worker(new URL("./inference.worker.ts", import.meta.url), { type: "module" })) {}

  private set(phase: Phase, reply?: Reply) {
    this.phase = phase;
    if (!this.disposed) this.update(phase, reply);
  }
  private arm(ms: number) {
    clearTimeout(this.deadline);
    this.deadline = setTimeout(() => void this.fail("Browser operation timed out. No server request was made."), ms);
  }
  private async policy() {
    const abort = new AbortController();
    this.policyAbort = abort;
    const timer = setTimeout(() => abort.abort(), 5000);
    try { await assertLocalPolicy(abort.signal); }
    finally { clearTimeout(timer); if (this.policyAbort === abort) this.policyAbort = undefined; }
  }
  private async lease() {
    if (!navigator.locks) throw new Error("Exclusive browser ownership unavailable");
    await new Promise<void>((resolve, reject) => {
      void navigator.locks.request(CACHE, { ifAvailable: true }, async (lock) => {
        if (!lock) { reject(new Error("Local mode is already open in another tab")); return; }
        await new Promise<void>((release) => { this.release = release; resolve(); });
      }).catch(reject);
    });
  }
  async check() {
    if (this.disposed || !["idle", "fallback"].includes(this.phase)) return;
    this.set("checking");
    const epoch = ++this.epoch;
    try {
      if ("__TAURI_INTERNALS__" in window) throw new Error("This evaluation is browser-only");
      await this.lease();
      if (epoch !== this.epoch) { this.release?.(); return; }
      await this.policy();
      if (epoch !== this.epoch) return;
      const worker = this.createWorker();
      this.worker = worker;
      worker.onmessage = ({ data }: MessageEvent<Reply>) => {
        if (epoch !== this.epoch || this.worker !== worker) return;
        if (!isReply(data)) { void this.fail("Invalid browser runtime response"); return; }
        if (data.kind === "failed") { void this.fail(data.reason); return; }
        if (data.kind === "supported" && this.phase === "checking") { clearTimeout(this.deadline); this.set("supported", data); }
        else if (data.kind === "progress" && this.phase === "loading") this.set("loading", data);
        else if (data.kind === "ready" && this.phase === "loading") { clearTimeout(this.deadline); this.set("ready", data); }
        else if (data.kind === "token" && this.phase === "generating") this.set("generating", data);
        else if (data.kind === "done" && this.phase === "generating") { clearTimeout(this.deadline); this.set("ready", data); }
        else void this.fail("Invalid browser runtime response");
      };
      worker.onerror = (event) => { event.preventDefault(); void this.fail("Browser worker failed. No server request was made."); };
      worker.onmessageerror = () => void this.fail("Browser worker response failed");
      this.arm(30_000);
      worker.postMessage({ kind: "probe" } satisfies Command);
      // Fail closed while idle as well as during work. A frozen/offline tab
      // cannot promise immediate revocation; each action also revalidates.
      this.poll = setInterval(() => void this.revalidate(), 30_000);
      document.addEventListener("visibilitychange", this.visibility);
    } catch (error) { if (epoch === this.epoch) await this.fail(error instanceof Error ? error.message : "Local mode unavailable"); }
  }
  private visibility = () => { if (!document.hidden) void this.revalidate(); };
  private async revalidate() {
    if (this.probingPolicy || !this.worker) return;
    this.probingPolicy = true;
    const epoch = this.epoch;
    try { await this.policy(); }
    catch { if (epoch === this.epoch) await this.fail("Local mode disabled or policy unavailable"); }
    finally { this.probingPolicy = false; }
  }
  async run(command: Exclude<Command, { kind: "probe" }>) {
    if (this.disposed) return;
    if (command.kind === "load" ? this.phase !== "supported" : this.phase !== "ready") return;
    if (command.kind === "generate" && (!command.prompt.trim() || command.prompt.length > MAX_PROMPT)) return;
    const epoch = this.epoch;
    this.set(command.kind === "load" ? "loading" : "generating");
    this.arm(command.kind === "load" ? 600_000 : 120_000);
    try {
      // Serialize policy validation with interval work; never reuse a stale allow.
      await this.policy();
      if (epoch === this.epoch) this.worker?.postMessage(command);
    } catch { if (epoch === this.epoch) await this.fail("Local mode disabled or policy unavailable"); }
  }
  async stop(removeCache: boolean, reason = "Stopped. No server request was made.") {
    if (this.stopPromise) return this.stopPromise;
    ++this.epoch;
    clearTimeout(this.deadline);
    clearInterval(this.poll);
    document.removeEventListener("visibilitychange", this.visibility);
    this.policyAbort?.abort();
    this.worker?.terminate();
    this.worker = undefined;
    this.set("stopping");
    this.stopPromise = (async () => {
      let cleanup = "Verified cache may be retained until you remove it or the browser evicts it.";
      // Only the holder may delete this cache. Another tab's active download
      // must survive a failed attempt to acquire the lease.
      if (removeCache && this.release) {
        try { await caches.delete(CACHE); cleanup = "App-owned model cache removed. HTTP caches and browser/OS copies cannot be guaranteed erased."; }
        catch { cleanup = "Cache removal failed. Clear this site's browser storage to remove retained artifacts."; }
      }
      this.release?.();
      this.release = undefined;
      this.set("fallback", { kind: "failed", reason: `${reason} ${cleanup}` });
    })();
    await this.stopPromise;
    this.stopPromise = undefined;
  }
  async removeCache() {
    if (!["idle", "fallback", "supported", "ready"].includes(this.phase) || this.disposed) return;
    if (!this.release) {
      this.set("stopping");
      try { await this.lease(); }
      catch { this.set("fallback", { kind: "failed", reason: "Cache is in use by another tab; it was not removed." }); return; }
    }
    await this.stop(true, "Model removed.");
  }
  private fail(reason: string) { return this.stop(true, reason); }
  suspend() { void this.stop(this.phase === "loading", "Page left; runtime released."); }
  dispose() { this.disposed = true; void this.stop(this.phase === "loading"); }
}
