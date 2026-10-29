import { spawn } from "node:child_process";

const outputLimit = 8192;
const termGraceMs = 500;
const killWaitMs = 2000;

// Each POSIX child leads its own group, including its esbuild subprocess.
// Only groups created here are signalled; never search for processes by name.
export function recorderBuildProcesses(signal, diagnostic = console.error) {
  const children = new Set();
  let closing = signal.aborted;
  function abort() {
    closing = true;
    for (const child of children) child.terminate();
  }
  signal.addEventListener("abort", abort, { once: true });

  return {
    run(args, label = "recorder build") {
      if (closing) return Promise.reject(new Error("recorder builds aborted"));
      const started = Date.now();
      const grouped = process.platform !== "win32";
      const child = spawn(process.execPath, args, {
        detached: grouped,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let aborted = false;
      let settled = false;
      let spawnError;
      let killTimer;
      let reapTimer;
      let resolve;
      let reject;
      const result = new Promise((yes, no) => { resolve = yes; reject = no; });
      const details = () => `${label.slice(0, 512)} pid=${child.pid ?? "unstarted"} `
        + `elapsed=${Date.now() - started}ms\nstdout (last ${outputLimit} bytes):\n${stdout}`
        + `\nstderr (last ${outputLimit} bytes):\n${stderr}`;
      function finish(error) {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        clearTimeout(reapTimer);
        children.delete(owned);
        if (error) reject(error);
        else resolve();
      }
      function send(name) {
        if (!child.pid) return;
        try {
          if (grouped) process.kill(-child.pid, name);
          else child.kill(name);
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
      const owned = {
        result,
        terminate() {
          if (settled || aborted) return;
          aborted = true;
          diagnostic(`Aborting ${details()}`);
          send("SIGTERM");
          killTimer = setTimeout(() => send("SIGKILL"), termGraceMs);
          reapTimer = setTimeout(() => {
            // Keep cleanup bounded even if the OS cannot reap a killed child.
            send("SIGKILL");
            child.stdout.destroy();
            child.stderr.destroy();
            child.unref();
            finish(new Error(`Recorder child did not close after SIGKILL: ${details()}`));
          }, termGraceMs + killWaitMs);
        },
      };
      children.add(owned);
      child.stdout.on("data", (chunk) => {
        stdout = Buffer.concat([stdout, chunk]).subarray(-outputLimit);
      });
      child.stderr.on("data", (chunk) => {
        stderr = Buffer.concat([stderr, chunk]).subarray(-outputLimit);
      });
      child.on("error", (error) => { spawnError = error; });
      // close, unlike exit, also waits for inherited stdout/stderr to close.
      child.on("close", (code, exitSignal) => {
        if (code === 0 && !aborted && !spawnError) finish();
        else {
          const error = new Error(`${aborted ? "Aborted" : "Failed"} ${details()}\n`
            + `exit=${code} signal=${exitSignal} ${spawnError?.message ?? ""}`);
          error.code = code;
          error.signal = exitSignal;
          finish(error);
        }
      });
      return result;
    },
    async close() {
      signal.removeEventListener("abort", abort);
      const pending = [...children];
      abort();
      await Promise.allSettled(pending.map((child) => child.result));
    },
  };
}
