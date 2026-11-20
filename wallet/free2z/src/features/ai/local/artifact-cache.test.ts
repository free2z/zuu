import { describe, it, expect, vi } from "vitest";
import { artifactStore, verifyArtifact } from "./artifact-cache";
import manifest from "./artifacts.json";

const bytes = new TextEncoder().encode("abc").buffer;
const artifact = { url: "https://example.test/model", bytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" };
function cacheFixture(initial = new Map<string, Response>()) {
  const cache = {
    match: vi.fn(async (url: string) => initial.get(url)?.clone()),
    keys: vi.fn(async () => [...initial.keys()].map((url) => new Request(url))),
    put: vi.fn(async (url: string, response: Response) => { initial.set(url, response); }),
  };
  return { cache, storage: { open: vi.fn(async () => cache) } as unknown as CacheStorage };
}
describe("local draft artifact boundary (synthetic bytes, not inference)", () => {
  it("pins one sub-billion model, every shard and library by immutable URL/size/hash", () => {
    expect(manifest.parameters).toBeLessThan(1_000_000_000);
    expect(manifest.downloadBytes).toBe(manifest.files.reduce((sum, file) => sum + file.bytes, 0));
    expect(manifest.files.filter((f) => f.url.includes("params_shard"))).toHaveLength(7);
    for (const file of manifest.files) {
      expect(file.url).toMatch(/^https:\/\/(huggingface.co|raw.githubusercontent.com)\//);
      expect(file.url).toContain(file.url.includes("huggingface") ? manifest.revision : manifest.libraryRevision);
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
  it("rejects size and digest corruption", async () => {
    await expect(verifyArtifact(bytes, artifact)).resolves.toBeUndefined();
    await expect(verifyArtifact(bytes, { ...artifact, bytes: 2 })).rejects.toThrow("size mismatch");
    await expect(verifyArtifact(bytes, { ...artifact, sha256: "0".repeat(64) })).rejects.toThrow("integrity mismatch");
  });
  it("downloads only approved artifacts and re-verifies warm cache without network", async () => {
    const { storage, cache } = cacheFixture();
    const network = vi.fn(async () => new Response(bytes));
    const store = artifactStore(storage, network, [artifact]);
    await expect(store.read("https://provider.invalid/prompt")).rejects.toThrow("Untrusted");
    expect(network).not.toHaveBeenCalled();
    await store.prepare(() => {});
    expect(network).toHaveBeenCalledWith(artifact.url, expect.objectContaining({ credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" }));
    expect(cache.put).toHaveBeenCalledTimes(1);
    expect((await store.keys()).map((r) => r.url)).toEqual([artifact.url]);
    await store.prepare(() => {});
    expect(network).toHaveBeenCalledTimes(1);
    expect(await (await store.read(artifact.url)).text()).toBe("abc");
  });
  it("rejects partial cache loss and oversized downloads instead of repairing without consent", async () => {
    const { storage, cache } = cacheFixture(new Map([[artifact.url, new Response(bytes)]]));
    const network = vi.fn(async () => new Response("too large"));
    await expect(artifactStore(storage, network, [artifact, { ...artifact, url: artifact.url + '2' }]).prepare(() => {})).rejects.toThrow("cache lost");
    expect(network).not.toHaveBeenCalled();
    await expect(artifactStore(cacheFixture().storage, network, [artifact]).prepare(() => {})).rejects.toThrow("exceeds pinned size");
    expect(cache.put).not.toHaveBeenCalled();
  });
  it("rejects corrupt warm cache and never consumes it", async () => {
    const { storage } = cacheFixture(new Map([[artifact.url, new Response("xyz")]]));
    await expect(artifactStore(storage, vi.fn(), [artifact]).prepare(() => {})).rejects.toThrow("integrity mismatch");
  });
});
