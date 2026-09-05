// #904 phase 4 moved the Mermaid renderer to `wallet/free2z`; see the header
// of `check-mermaid-security.mjs` for why this guard followed it here instead
// of being deleted with ZUULI's copy.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertPatchedDomPurify,
  assertPatchedMermaid,
  checkManifestAndLock,
} from "./check-mermaid-security.mjs";

test("advisory guard rejects both vulnerable Mermaid release lines", () => {
  for (const version of ["10.6.0", "10.9.6", "11.0.0-alpha.1", "11.16.0"]) {
    assert.throws(() => assertPatchedMermaid(version), /GHSA-2v8p-3f2j-5mp7/);
  }
  for (const version of ["10.9.8", "11.16.1", "11.17.0", "12.0.0"]) {
    assert.doesNotThrow(() => assertPatchedMermaid(version));
  }
});

test("manifest and every lock entry must stay exact, patched and aligned", () => {
  const manifest = {
    dependencies: { dompurify: "3.4.14", mermaid: "11.17.0" },
  };
  const lock = {
    packages: {
      "node_modules/dompurify": { version: "3.4.14" },
      "node_modules/mermaid": { version: "11.17.0" },
    },
  };
  assert.doesNotThrow(() => checkManifestAndLock(manifest, lock));
  assert.throws(
    () =>
      checkManifestAndLock(
        { dependencies: { dompurify: "3.4.14", mermaid: "^11.17.0" } },
        lock,
      ),
    /exact semantic version/,
  );
  assert.throws(
    () =>
      checkManifestAndLock(manifest, {
        packages: {
          "node_modules/dompurify": { version: "3.4.14" },
          "node_modules/mermaid": { version: "11.17.0" },
          "node_modules/example/node_modules/mermaid": { version: "10.9.6" },
        },
      }),
    /GHSA-2v8p-3f2j-5mp7/,
  );
});

test("SVG sink guard rejects known-vulnerable DOMPurify lines", () => {
  for (const version of ["3.3.3", "3.4.12"]) {
    assert.throws(() => assertPatchedDomPurify(version), /DOMPurify/);
  }
  assert.doesNotThrow(() => assertPatchedDomPurify("3.4.14"));
});

test("free2z's committed manifest and lock remain patched and aligned", async () => {
  const [manifest, lock] = await Promise.all([
    readFile(new URL("../../free2z/package.json", import.meta.url), "utf8").then(
      JSON.parse,
    ),
    readFile(
      new URL("../../free2z/package-lock.json", import.meta.url),
      "utf8",
    ).then(JSON.parse),
  ]);
  assert.doesNotThrow(() => checkManifestAndLock(manifest, lock));
});

test("this app is the one that no longer renders Mermaid", async () => {
  // The reason the guard moved. If ZUULI ever takes a Mermaid dependency back
  // this fails, and whoever did it has to decide deliberately whether the
  // renderer belongs next to the seed again (#904, #367).
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  for (const name of ["mermaid", "dompurify", "react-markdown"]) {
    assert.equal(
      manifest.dependencies?.[name],
      undefined,
      `the wallet authority must not depend on ${name}`,
    );
  }
});

test("creator-controlled Mermaid render stays off the free2z UI thread", async () => {
  const [component, worker] = await Promise.all([
    readFile(new URL("../../free2z/src/components/common/Mermaid.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../free2z/src/components/common/mermaid.worker.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(component, /import\(["']mermaid["']\)|mermaid\.render/);
  assert.match(component, /worker\.terminate\(\)/);
  assert.match(worker, /await mermaid\.render\(/);
});
