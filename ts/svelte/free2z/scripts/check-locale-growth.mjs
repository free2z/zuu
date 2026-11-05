// Destructive only to our disposable fixture: original inputs are restored in finally.
// Run from the Free2Z UI root with locked dependencies and Playwright installed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, unlink, access } from "node:fs/promises";
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright";

const loaderPath = "src/lib/catalog-loader.js";
const registryPath = "src/lib/locale.js";
const fixturePath = "src/lib/locales/zz-ZZ.json";
const rtkFixturePath = "src/lib/locales/rtk/zz-ZZ.json";
const sentinel = "GROWTH_PROOF_UNUSED_CATALOG_2026";
const budget = 4096; // Raw AND gzip; tiny index/build noise, <0.4% of 1 MiB fixture.
const originalLoader = await readFile(loaderPath, "utf8");
const originalRegistry = await readFile(registryPath, "utf8");
try {
  await access(fixturePath);
  throw new Error(`Refusing to overwrite ${fixturePath}`);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
try {
  await access(rtkFixturePath);
  throw new Error(`Refusing to overwrite ${rtkFixturePath}`);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
function build() {
  const result = spawnSync("npm", ["run", "build"], {
    encoding: "utf8",
    maxBuffer: 20_000_000,
  });
  if (result.status !== 0)
    throw new Error(
      `build failed: ${result.stderr}\n${result.stdout.slice(-4000)}`,
    );
}
async function port() {
  const server = createServer();
  await new Promise((resolve, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", resolve),
  );
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}
async function ready(url, child) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`server exited ${child.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start: ${url}`);
}
async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}
async function measure() {
  const appPort = await port(),
    mockPort = await port();
  const origin = `http://127.0.0.1:${appPort}`,
    mock = `http://127.0.0.1:${mockPort}`;
  const env = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(appPort),
    ORIGIN: origin,
    MOCK_API_PORT: String(mockPort),
    MOCK_TRUSTED_APP_ORIGIN: origin,
    PRIVATE_API_BASE_URL: mock,
    PRIVATE_BACKEND_TRUSTED_ORIGINS: origin,
    VITE_API_PROXY_TARGET: mock,
    PUBLIC_API_BASE_URL: "",
    PUBLIC_STRIPE_CHECKOUT_ENABLED: "true",
  };
  const api = spawn(process.execPath, ["tests/browser/mock-api.mjs"], {
    env,
    stdio: "ignore",
  });
  let app, browser;
  try {
    await ready(`${mock}/healthz`, api);
    app = spawn(process.execPath, ["build"], { env, stdio: "ignore" });
    await ready(`${origin}/healthz`, app);
    const manifest = JSON.parse(
      await readFile(".svelte-kit/output/client/.vite/manifest.json", "utf8"),
    );
    const seen = new Set();
    function visit(key) {
      if (seen.has(key) || !manifest[key]) return;
      seen.add(key);
      for (const dependency of manifest[key].imports ?? []) visit(dependency);
    }
    for (const [key, entry] of Object.entries(manifest))
      if (
        (entry.isEntry || entry.isDynamicEntry) &&
        !/^src\/lib\/locales\/(?:rtk\/)?[^/]+\.json$/.test(key)
      )
        visit(key);
    const staticCatalogs = [...seen].filter((key) =>
      /^src\/lib\/locales\/(?:rtk\/)?(en|es|fr|pt-BR|zz-ZZ)\.json$/.test(key),
    );
    const fixtureChunk = manifest["src/lib/locales/zz-ZZ.json"]?.file ?? null;
    const rtkFixtureChunk =
      manifest["src/lib/locales/rtk/zz-ZZ.json"]?.file ?? null;
    browser = await chromium.launch({ headless: true });
    const results = {};
    for (const locale of ["en", "fr"]) {
      const page = await browser.newPage();
      const assets = new Map();
      const pending = [];
      page.on("response", (response) => {
        const url = new URL(response.url());
        if (
          url.origin !== origin ||
          !url.pathname.startsWith("/_app/immutable/")
        )
          return;
        pending.push(
          response
            .body()
            .then((body) => assets.set(url.pathname, body))
            .catch(() => {}),
        );
      });
      const response = await page.goto(`${origin}/trending?lang=${locale}`, {
        waitUntil: "networkidle",
        timeout: 30000,
      });
      assert.equal(response.status(), 200);
      const html = await response.body();
      assert.equal(await page.locator("html").getAttribute("lang"), locale);
      await Promise.all(pending);
      const chunks = [...assets.entries()];
      const joined = Buffer.concat(chunks.map(([, body]) => body));
      const excludedMarkers = {
        es: "Publica de forma independiente, conecta directamente con tus lectores y recibe apoyo, incluidos pagos directos con Zcash.",
        fr: "Publiez de manière indépendante, échangez directement avec vos lecteurs et recevez du soutien, notamment grâce aux paiements directs en Zcash.",
        "pt-BR":
          "Publique de forma independente, conecte-se diretamente com seus leitores e receba apoio, inclusive por pagamentos diretos em Zcash.",
      };
      const unexpectedCatalogMarkers = Object.entries(excludedMarkers)
        .filter(
          ([tag, marker]) =>
            tag !== locale &&
            (html.includes(marker) || joined.includes(marker)),
        )
        .map(([tag]) => tag);
      results[locale] = {
        htmlRaw: html.length,
        htmlGzip: gzipSync(html).length,
        assetsRaw: joined.length,
        assetsGzip: chunks.reduce(
          (n, [, body]) => n + gzipSync(body).length,
          0,
        ),
        assetCount: chunks.length,
        fixtureRequested:
          !!fixtureChunk &&
          chunks.some(([path]) => path.endsWith(fixtureChunk)),
        rtkFixtureRequested:
          !!rtkFixtureChunk &&
          chunks.some(([path]) => path.endsWith(rtkFixtureChunk)),
        sentinelHtml: html.includes(sentinel),
        sentinelAssets: joined.includes(sentinel),
        unexpectedCatalogMarkers,
      };
      await page.close();
    }
    if (fixtureChunk) {
      const response = await fetch(`${origin}/trending?lang=zz-ZZ`, {
        headers: { "accept-language": "en" },
      });
      assert.match(
        await response.text(),
        /<html lang="en"/,
        "disabled synthetic locale became selectable",
      );
    }
    return { staticCatalogs, fixtureChunk, rtkFixtureChunk, results };
  } finally {
    if (browser) await browser.close();
    if (app) await stop(app);
    await stop(api);
  }
}
function assertSafe(measurement) {
  assert.deepEqual(
    measurement.staticCatalogs,
    [],
    "catalog statically reachable from a client entry",
  );
  for (const [locale, result] of Object.entries(measurement.results)) {
    assert.equal(
      result.fixtureRequested,
      false,
      `${locale}: fixture requested`,
    );
    assert.equal(
      result.rtkFixtureRequested,
      false,
      `${locale}: RTK fixture requested`,
    );
    assert.deepEqual(
      result.unexpectedCatalogMarkers,
      [],
      `${locale}: unselected catalog marker present`,
    );
    assert.equal(
      result.sentinelHtml || result.sentinelAssets,
      false,
      `${locale}: fixture bytes delivered`,
    );
  }
}
function compare(base, changed) {
  for (const locale of ["en", "fr"])
    for (const metric of ["htmlRaw", "htmlGzip", "assetsRaw", "assetsGzip"]) {
      const delta =
        changed.results[locale][metric] - base.results[locale][metric];
      assert.ok(
        delta <= budget,
        `${locale} ${metric} grew ${delta} bytes (limit ${budget})`,
      );
    }
}
try {
  console.log("building baseline");
  build();
  const baseline = await measure();
  assertSafe(baseline);
  let data = sentinel;
  for (let i = 0; data.length < 1_200_000; i++)
    data += createHash("sha256").update(String(i)).digest("hex");
  await writeFile(fixturePath, JSON.stringify({ sentinel: data }));
  await writeFile(rtkFixturePath, JSON.stringify({ sentinel: data }));
  const registry = originalRegistry
    .replace(
      "]);\nexport const SUPPORTED_LOCALES",
      '  { code: "zz-ZZ", label: "Synthetic", script: "Latn", direction: "ltr", formattingLocale: "en", fallback: "en", availability: "disabled", loadCatalog: () => import("./locales/zz-ZZ.json"), loadRtk: () => import("./locales/rtk/zz-ZZ.json") },\n]);\nexport const SUPPORTED_LOCALES',
    )
    .replace(
      "LOCALE_REGISTRY.map(({ code }) => code)",
      'LOCALE_REGISTRY.filter(({ code }) => code !== "zz-ZZ").map(({ code }) => code)',
    )
    .replace(
      "LOCALE_REGISTRY.map(({ code, label }) => ({",
      'LOCALE_REGISTRY.filter(({ code }) => code !== "zz-ZZ").map(({ code, label }) => ({',
    )
    .replace(
      '  if (tag === "pt" || tag === "pt-BR")',
      '  if (tag === "zz-ZZ") return null;\n  if (tag === "pt" || tag === "pt-BR")',
    );
  assert.notEqual(registry, originalRegistry);
  await writeFile(registryPath, registry);
  const dynamic = originalLoader;
  console.log("building disabled synthetic locale");
  build();
  const expanded = await measure();
  assert.ok(expanded.fixtureChunk, "synthetic locale was not built");
  assert.ok(expanded.rtkFixtureChunk, "synthetic RTK locale was not built");
  assertSafe(expanded);
  compare(baseline, expanded);
  await writeFile(
    loaderPath,
    `import syntheticGrowthFixture from "./locales/zz-ZZ.json";\nimport syntheticRtkFixture from "./locales/rtk/zz-ZZ.json";\nglobalThis.__localeGrowthNegativeControl = [syntheticGrowthFixture, syntheticRtkFixture];\n${dynamic}`,
  );
  console.log("building eager negative control");
  build();
  const eager = await measure();
  assert.throws(
    () => {
      assertSafe(eager);
      compare(baseline, eager);
    },
    /catalog|fixture|grew/,
    "eager negative control escaped detection",
  );
  console.log(
    JSON.stringify(
      {
        budgetBytes: budget,
        fixtureBytes: data.length,
        baseline,
        expanded,
        eager,
      },
      null,
      2,
    ),
  );
} finally {
  await writeFile(loaderPath, originalLoader);
  await writeFile(registryPath, originalRegistry);
  await unlink(rtkFixturePath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  await unlink(fixturePath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  console.log("restoring production build");
  build();
}
