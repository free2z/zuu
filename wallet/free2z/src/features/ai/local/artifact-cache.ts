import manifest from "./artifacts.json";
import { CACHE } from "./protocol";

export async function verifyArtifact(bytes: ArrayBuffer, artifact: { bytes: number; sha256: string }) {
  if (bytes.byteLength !== artifact.bytes) throw new Error("Artifact size mismatch");
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (v) => v.toString(16).padStart(2, "0")).join("");
  if (hash !== artifact.sha256) throw new Error("Artifact integrity mismatch");
}

/** Own cache only. Never use the runtime's shared caches or store a prompt. */
export function artifactStore(storage: CacheStorage, network: typeof fetch, files = manifest.files) {
  const known = new Map(files.map((file) => [file.url, file]));
  async function read(url: string) {
    const artifact = known.get(url);
    if (!artifact) throw new Error("Untrusted artifact request blocked");
    const cache = await storage.open(CACHE);
    const response = await cache.match(url);
    if (!response) throw new Error("Model cache lost. Choose download again or server completion.");
    const bytes = await response.arrayBuffer();
    await verifyArtifact(bytes, artifact);
    return new Response(bytes);
  }
  return {
    read,
    async keys() {
      const cache = await storage.open(CACHE);
      return (await cache.keys()).filter((request) => known.has(request.url));
    },
    async prepare(progress: (text: string) => void) {
      const cache = await storage.open(CACHE);
      const present = await Promise.all(files.map((file) => cache.match(file.url)));
      if (present.some(Boolean) && !present.every(Boolean)) {
        throw new Error("Partial model cache lost. Choose download again or server completion.");
      }
      for (const [index, file] of files.entries()) {
        progress(`${present[index] ? "Verifying cache" : "Downloading"} ${index + 1}/${files.length}`);
        if (present[index]) { await read(file.url); continue; }
        // Only fixed HTTPS upstream URLs. Redirects are CDN delivery; bytes are
        // bounded and hashed before caching or handing anything to the runtime.
        const response = await network(file.url, { credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
        if (!response.ok || !response.body) throw new Error("Model download failed");
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > file.bytes) throw new Error("Artifact exceeds pinned size");
            chunks.push(value);
          }
        } finally { await reader.cancel(); }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        await verifyArtifact(bytes.buffer, file);
        await cache.put(file.url, new Response(bytes));
      }
    },
  };
}
