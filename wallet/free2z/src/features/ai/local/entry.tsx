import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { LocalDraftController, type Phase } from "./controller";
import { MAX_PROMPT, type Metrics, type Reply } from "./protocol";
import manifest from "./artifacts.json";
import "../../../index.css";

function Evaluation() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("Check support first. Nothing downloads automatically.");
  const [prompt, setPrompt] = useState("");
  const [output, setOutput] = useState("");
  const [metrics, setMetrics] = useState<Metrics>({});
  const controller = useRef<LocalDraftController>();
  useEffect(() => {
    const instance = new LocalDraftController((next, reply?: Reply) => {
      setPhase(next);
      if (!reply) {
        if (next === "checking") setStatus("Checking policy and WebGPU capability…");
        if (next === "loading") setStatus("Checking policy before loading…");
        if (next === "generating") setStatus("Generating on this device…");
        if (next === "stopping") setStatus("Stopping worker and checking cache cleanup…");
      }
      if (reply?.kind === "supported") setStatus(reply.description);
      if (reply?.kind === "failed") setStatus(reply.reason);
      if (reply?.kind === "progress") setStatus(reply.text);
      if (reply?.kind === "ready") { setStatus("Ready. Prompts stay in this worker; no server fallback is automatic."); setMetrics(reply.metrics); }
      if (reply?.kind === "token") setOutput(reply.text);
      if (reply?.kind === "done") { setStatus("Draft finished. Review its quality before using it."); setMetrics((old) => ({ ...old, ...reply.metrics })); }
    });
    controller.current = instance;
    const leave = () => { instance.suspend(); };
    window.addEventListener("pagehide", leave);
    return () => { window.removeEventListener("pagehide", leave); instance.dispose(); };
  }, []);
  const button = "min-tap cursor-pointer rounded border border-border px-4 py-2 disabled:cursor-default disabled:opacity-50";
  const busy = ["checking", "loading", "generating", "stopping"].includes(phase);
  return <main className="mx-auto max-w-2xl space-y-5 p-6">
    <h1 className="text-2xl font-bold">On-device draft evaluation</h1>
    <p>Experimental, default off. SmolLM2 360M is a small English draft model and can produce poor or incorrect answers. Physical device acceptance is still open.</p>
    <p>No prompt or output is saved, logged, or sent by this page. Download hosts see your IP and artifact requests. This page has no telemetry. Other browser extensions and the operating system are outside its control.</p>
    <p>{manifest.model}, {manifest.license}. First-run model download: <strong>{manifest.downloadBytes.toLocaleString("en-US")} bytes ({(manifest.downloadBytes / 1024 ** 2).toFixed(2)} MiB)</strong>, plus this page’s app code. Expected persistent model storage: the same payload plus browser overhead. Allow at least 650 MiB free disk for temporary copies. Runtime RAM/GPU memory is additional and device dependent; upstream estimates 579.61 MB VRAM, not a measured peak.</p>
    <p>Verified artifacts remain in this site’s cache for warm loads. Storage may be denied or evicted. Cancel during download removes the app-owned cache where possible; browser HTTP caches and OS copies cannot be guaranteed erased.</p>
    <p role="status" aria-live="polite" className="break-words">{status}</p>
    <div className="flex flex-wrap gap-3">
      <button className={button} disabled={!["idle", "fallback"].includes(phase)} onClick={() => void controller.current?.check()}>Check WebGPU support</button>
      <button className={button} disabled={phase !== "supported"} onClick={() => void controller.current?.run({ kind: "load" })}>Opt in: download or load model</button>
      <button className={button} disabled={phase === "stopping" || phase === "idle"} onClick={() => void controller.current?.stop(phase === "loading")}>Cancel and release runtime</button>
      <button className={button} disabled={busy} onClick={() => void controller.current?.removeCache()}>Remove model cache</button>
    </div>
    <label className="block" htmlFor="local-prompt">Local draft prompt (maximum {MAX_PROMPT} characters)</label>
    <textarea id="local-prompt" className="w-full rounded border border-border bg-background p-3" rows={4} maxLength={MAX_PROMPT} autoComplete="off" spellCheck={false} value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={busy} />
    <button className={button} disabled={phase !== "ready" || !prompt.trim()} onClick={() => { setOutput(""); setMetrics((old) => ({ loadMs: old.loadMs })); void controller.current?.run({ kind: "generate", prompt }); }}>Generate on this device</button>
    <section aria-label="Local draft output" className="whitespace-pre-wrap break-words" aria-live="polite">{output}</section>
    <p className="text-sm" aria-label="Local timing measurements">Load: {metrics.loadMs?.toFixed(0) ?? "not measured"} ms; first token: {metrics.firstTokenMs?.toFixed(0) ?? "not measured"} ms; finished: {metrics.finishedMs?.toFixed(0) ?? "not measured"} ms. Timings include runtime work, not proof of a physical GPU. Memory, heat and battery require separate measurement.</p>
    <section aria-label="Server fallback" className="space-y-3 rounded border border-border p-4">
      <h2 className="font-bold">Prefer server completion?</h2>
      <p>For unsupported devices, cache loss, browser errors, offline policy checks or poor results, you can switch explicitly. Your local draft is not copied. The server chat sends text only after you enter a message and press Send; its usual account, pricing and privacy rules apply.</p>
      <a className="cursor-pointer underline" href="/ai" onClick={() => controller.current?.dispose()}>Switch to server completion</a>
    </section>
  </main>;
}

createRoot(document.getElementById("root")!).render(import.meta.env.VITE_LOCAL_DRAFT_EVALUATION === "1"
  ? <Evaluation /> : <main><h1>Local draft evaluation is disabled</h1><a href="/ai">Open server chat</a></main>);
