import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LOCALE,
  isContentLanguageRoute,
  normalizeLocale,
  resolveLocale,
  resolveRequestLocale,
} from "../src/lib/locale.js";

test("normalizes supported regional browser locales", () => {
  assert.equal(normalizeLocale("es-VE"), "es");
  assert.equal(normalizeLocale("FR-ca"), "fr");
  assert.equal(normalizeLocale("en-US"), "en");
  assert.equal(normalizeLocale("pt-BR"), "pt-BR");
  assert.equal(normalizeLocale("pt_BR"), "pt-BR");
  assert.equal(normalizeLocale("pt-PT"), null);
});

test("rejects unsupported or invalid locales", () => {
  assert.equal(normalizeLocale("de-DE"), null);
  assert.equal(normalizeLocale("ptx-BR"), null);
  assert.equal(normalizeLocale(""), null);
  assert.equal(normalizeLocale(null), null);
});

test("prefers a saved selection over the browser locale", () => {
  assert.equal(
    resolveLocale({ savedLocale: "fr", browserLocale: "es-VE" }),
    "fr",
  );
});

test("uses the browser locale when there is no saved selection", () => {
  assert.equal(resolveLocale({ browserLocale: "es-MX" }), "es");
  assert.equal(resolveLocale({ browserLocale: "pt" }), "pt-BR");
});

test("prefers a saved Brazilian Portuguese selection", () => {
  assert.equal(
    resolveLocale({ savedLocale: "pt-BR", browserLocale: "fr-FR" }),
    "pt-BR",
  );
});

test("falls back to English when neither preference is supported", () => {
  assert.equal(resolveLocale({ browserLocale: "de-DE" }), DEFAULT_LOCALE);
});

test("the editor's content language query does not switch its UI locale", () => {
  assert.equal(isContentLanguageRoute("/edit"), true);
  assert.deepEqual(
    resolveRequestLocale({
      routeId: "/edit",
      queryLocale: "fr",
      cookieLocale: "es",
    }),
    { locale: "es", persisted: true },
  );
  assert.deepEqual(
    resolveRequestLocale({
      routeId: "/edit",
      queryLocale: "fr",
      cookieLocale: null,
    }),
    { locale: "en", persisted: false },
  );
});

// --- catalog integrity -----------------------------------------------------
//
// These guard the two ways the catalogs silently rot: a `t()` key that exists
// in code but not in `en.json` (renders the raw key, or the English fallback
// forever), and a translation file that drifts out of sync with the set of
// keys it is supposed to cover. Nothing else in CI checks either one.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UI_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(UI_ROOT, "..", "src");
const LOCALES = path.join(SRC, "lib", "locales");
const APP_LOCALES = ["en", "es", "fr", "pt-BR"];

function readCatalog(dir, locale) {
  return JSON.parse(fs.readFileSync(path.join(dir, `${locale}.json`), "utf8"));
}

function flatten(value, prefix = "", out = new Map()) {
  for (const [key, child] of Object.entries(value)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) {
      flatten(child, full, out);
    } else {
      out.set(full, child);
    }
  }
  return out;
}

function sourceFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // `api/` is generated; `locales/` is the catalogs themselves.
      if (entry.name === "api" || entry.name === "locales") continue;
      sourceFiles(full, found);
    } else if (/\.(svelte|ts)$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

function appSourceFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "api" || entry.name === "locales") continue;
      appSourceFiles(full, found);
    } else if (/\.(js|svelte|ts)$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

// These are the catalog prefixes owned by the editor's translation flow. The
// source uses literal keys today, including the ternary storage-cleanup call,
// so scanning string literals catches all of the flow's call sites without
// pretending to understand arbitrary dynamic i18n keys. There are currently
// no intentional catalog-only exceptions; a future dynamic path must add its
// key to this allow-list with a reason rather than silently growing dead copy.
const TRANSLATION_EDITOR_KEY_PREFIXES = [
  "editor.translate",
  "editor.translation",
];
const TRANSLATION_EDITOR_KEY_ALLOWLIST = new Set();

function isTranslationEditorKey(key) {
  return TRANSLATION_EDITOR_KEY_PREFIXES.some((prefix) =>
    key.startsWith(prefix),
  );
}

function appSourceKeys(files) {
  const keys = new Set();
  const pattern = /["'`](editor\.[A-Za-z0-9_.-]+)["'`]/g;
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const [, key] of source.matchAll(pattern)) keys.add(key);
  }
  return keys;
}

// Keys the code references but en.json does not define yet — the pre-existing
// gap tracked by. Tolerated so the check enforces "no NEW misses" without
// forcing the whole backlog into one PR. See the file header for the contract.
function loadMissingBaseline() {
  const file = path.join(UI_ROOT, "i18n-missing-keys-baseline.txt");
  if (!fs.existsSync(file)) return new Set();
  return new Set(
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  );
}

// Mirror the SHIPPED getTranslation() resolution in src/lib/i18n.ts, which is
// a PREFIX strip: a `common.x` key falls back to root-level `x`
// (key.startsWith("common.") → key.slice(7)). This is deliberately NOT the
// `key.replace("common.", "")` (first-occurrence-anywhere) form some older
// code used — that would also rewrite `editor.common.foo` → `editor.foo` and
// mark keys "covered" that the real runtime would render raw. Model exactly
// what ships, or the check hides real misses.
function resolvesInEnglish(english, key) {
  if (english.has(key)) return true;
  if (key.startsWith("common.") && english.has(key.slice("common.".length)))
    return true;
  return false;
}

test("every t() key used in the app exists in the English catalog", () => {
  const english = flatten(readCatalog(LOCALES, "en"));
  const baseline = loadMissingBaseline();
  // `$t(...)`, bare `t(...)`, and the defineMessage/translateMessage helpers.
  const pattern =
    /(?:\$t|\bt|translateMessage|defineMessage)\(\s*(["'`])([A-Za-z0-9_.$-]+)\1/g;

  const missing = new Map(); // key -> first file it was seen in
  for (const file of sourceFiles(SRC)) {
    const source = fs.readFileSync(file, "utf8");
    for (const [, , key] of source.matchAll(pattern)) {
      // Keys are always dotted; a bare word is some other single-arg call.
      if (!key.includes(".")) continue;
      if (resolvesInEnglish(english, key)) continue;
      if (!missing.has(key)) missing.set(key, path.relative(UI_ROOT, file));
    }
  }

  // Fail only on NEW misses — a referenced key that is neither in en.json nor
  // grandfathered in the  baseline.
  const newMisses = [...missing.keys()]
    .filter((key) => !baseline.has(key))
    .map((key) => `${key}  (${missing.get(key)})`)
    .sort();
  assert.deepEqual(
    newMisses,
    [],
    "New i18n keys referenced in code but missing from en.json. Add them to " +
      "en.json (and es/fr/pt-BR), or, if they belong to the #756 backlog, to " +
      "tests/i18n-missing-keys-baseline.txt.",
  );

  // Keep the baseline honest: once a grandfathered key is backfilled, it must
  // be removed so the backlog can only shrink.
  const stale = [...baseline].filter((key) => !missing.has(key)).sort();
  assert.deepEqual(
    stale,
    [],
    "These keys are in the #756 baseline but are no longer missing — remove " +
      "them from tests/i18n-missing-keys-baseline.txt.",
  );
});

test("translation-flow catalog keys are reachable from the app", () => {
  const english = flatten(readCatalog(LOCALES, "en"));
  const referenced = appSourceKeys(appSourceFiles(SRC));
  const dead = [...english.keys()]
    .filter(isTranslationEditorKey)
    .filter(
      (key) =>
        !referenced.has(key) && !TRANSLATION_EDITOR_KEY_ALLOWLIST.has(key),
    )
    .sort();

  assert.deepEqual(
    dead,
    [],
    "These translation-flow catalog keys are not referenced by app source. " +
      "Delete dead copy, or document a genuinely dynamic key in the explicit " +
      "allow-list.",
  );
});

test("translation catalogs match the English key set exactly", () => {
  const english = flatten(readCatalog(LOCALES, "en"));

  for (const locale of APP_LOCALES.filter((l) => l !== "en")) {
    const translated = flatten(readCatalog(LOCALES, locale));

    const missing = [...english.keys()].filter((k) => !translated.has(k));
    const extra = [...translated.keys()].filter((k) => !english.has(k));
    assert.deepEqual(missing, [], `${locale}.json is missing keys`);
    assert.deepEqual(extra, [], `${locale}.json has keys en.json does not`);

    for (const [key, value] of translated) {
      assert.equal(
        typeof value === "string" && value.trim().length > 0,
        true,
        `${locale}.json has an empty value for ${key}`,
      );

      // A `{placeholder}` dropped in translation renders as a missing word;
      // an invented one renders as a literal brace to the user.
      const placeholders = (s) =>
        [...String(s).matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]).sort();
      assert.deepEqual(
        placeholders(value),
        placeholders(english.get(key)),
        `${locale}.json placeholder mismatch for ${key}`,
      );
    }
  }
});

// User-facing copy must describe the system that actually ships. In
// particular, Free2Z stores pages in its own service; it is not a Web3 or
// decentralized publishing network. Keep this denylist deliberately narrow:
// it catches architecture claims, not ordinary privacy or Zcash copy. Zcash
// payment copy is checked by the same denylist as every other locale; there
// are no marketing exceptions for blockchain or settlement claims.
const UNSUPPORTED_ARCHITECTURE_CLAIMS = [
  { label: "Web3", pattern: /\bweb3\b/i },
  {
    label: "blockchain publication",
    pattern:
      /\b(?:publish\w*|publishing|content|zpages?|pages?|public\w*|contenido|contenu|p[aá]ginas?)\b[^\n.!?]{0,60}\b(?:blockchain|block[- ]chain|cadena de bloques|cha[iî]ne de blocs)\b|\b(?:blockchain|block[- ]chain|cadena de bloques|cha[iî]ne de blocs)\b[^\n.!?]{0,60}\b(?:publish\w*|publishing|content|zpages?|pages?|public\w*|contenido|contenu|p[aá]ginas?)\b/iu,
  },
  {
    label: "decentralized service",
    pattern: /\b(?:decentral\w*|d[eé]central\w*|descentral\w*)\b/iu,
  },
  {
    label: "on-chain publication",
    pattern:
      /\b(?:on[- ]chain|en cadena de bloques|sur la blockchain|na blockchain)\b/i,
  },
  {
    label: "immutable content",
    pattern: /\b(?:immutab\w*|inmutab\w*|imutab\w*)\b/iu,
  },
  {
    label: "trustless or censorship-proof service",
    pattern:
      /\b(?:trustless|permissionless|self[- ]sovereign|censorship[- ]proof)\b/i,
  },
  {
    label: "unqualified private Zcash/payment claim",
    pattern:
      /\b(?:private|privad[oa]s?|priv[ée]e?s?|confidential\w*|confident\w*)\b.{0,35}\b(?:zcash|payments?|donations?|pagos?|pagamentos?|paiements?)\b|\b(?:zcash|payments?|donations?|pagos?|pagamentos?|paiements?)\b.{0,35}\b(?:private|privad[oa]s?|priv[ée]e?s?|confidential\w*|confident\w*)\b/iu,
  },
  {
    label: "privacy by default",
    pattern:
      /\b(?:private by default|privacidad por defecto|privacidade por padrão|confidentialité assurée par défaut)\b/iu,
  },
  {
    label: "unqualified anonymity or identity claim",
    pattern:
      /\b(?:browse|access|join|publish|register|use|navega\w*|accede\w*|publica\w*|registra\w*|utiliza\w*|parcour\w*|acc[eè]d\w*|publie\w*|inscri\w*|utilis\w*)\b[^\n.!?]{0,35}\banonym\w*\b|\b(?:anonymous|anonymity|an[oóô]nim\w*)\b[^\n.!?]{0,35}\b(?:access|browsing|accounts?|identit\w*|acceso|cuentas?|identidad|acc[eè]s|comptes?|identit\w*)\b|\bwithout\s+(?:revealing|sharing)\s+(?:your|their)\s+(?:real[- ]world\s+)?identity\b/iu,
  },
];

test("locale catalogs do not make unsupported architecture claims", () => {
  const findings = [];

  for (const locale of APP_LOCALES) {
    const catalog = flatten(readCatalog(LOCALES, locale));
    for (const [key, value] of catalog) {
      if (typeof value !== "string") {
        continue;
      }
      for (const { label, pattern } of UNSUPPORTED_ARCHITECTURE_CLAIMS) {
        if (pattern.test(value)) {
          findings.push(`${locale}.${key}: ${label}`);
        }
      }
    }
  }

  assert.deepEqual(
    findings,
    [],
    "Locale copy contains an unsupported Web3/blockchain architecture claim. " +
      "Describe the deployed service, or add a narrowly justified allowlist " +
      "entry for a factual payment statement.",
  );
});

// The Svelte catalogs are not the only place users encounter marketing copy.
// Walk every user-facing documentation and frontend source tree so a newly
// added page or component cannot bypass this guard merely because nobody
// remembered to add it to a finite hand-maintained list. The component roots
// include visible labels and notification fallbacks; internal API/server code
// is intentionally excluded. Feature-level access labels (for example,
// "private stream") remain allowed unless they make a prohibited Zcash/payment
// or absolute privacy promise.
const REPO_ROOT = path.resolve(UI_ROOT, "../../../..");
const MARKETING_SURFACE_ROOTS = [
  "docs/about-free2z/docs",
  "docs/about-free2z/src",
  "docs/about-free2z/OUTLINE.md",
  "new-docs",
  "ts/react/free2z/public",
  "ts/react/free2z/src",
  "ts/svelte/free2z/src/routes",
  "ts/svelte/free2z/src/lib/components",
  // Shared fallback descriptors can render without a route/component-owned
  // string: metadata, stream/payment services, stores, and API error clients
  // are therefore part of the user-facing copy surface too.
  "ts/svelte/free2z/src/lib/meta.ts",
  "ts/svelte/free2z/src/lib/services",
  "ts/svelte/free2z/src/lib/stores",
  "ts/svelte/free2z/src/lib/api",
  "ts/svelte/free2z/src/lib/nav-links.js",
  "ts/svelte/free2z/src/lib/utils/event-notifications.ts",
  "ts/svelte/free2z/src/lib/components/HomeCTA.svelte",
  // Deliberately exclude lib/server, generated locale packs, and other
  // internal utility trees: they contain transport/configuration text rather
  // than strings rendered to users by this frontend.
];
const MARKETING_TEXT_EXTENSIONS = new Set([
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mdx",
  ".mts",
  ".svelte",
  ".ts",
  ".tsx",
]);

function collectMarketingSurfaceFiles(relativeRoot, found = []) {
  const absoluteRoot = path.join(REPO_ROOT, relativeRoot);
  if (!fs.existsSync(absoluteRoot)) return found;
  const stat = fs.statSync(absoluteRoot);
  if (stat.isFile()) {
    if (MARKETING_TEXT_EXTENSIONS.has(path.extname(absoluteRoot))) {
      found.push(relativeRoot);
    }
    return found;
  }
  for (const entry of fs.readdirSync(absoluteRoot, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    collectMarketingSurfaceFiles(path.join(relativeRoot, entry.name), found);
  }
  return found;
}

const MARKETING_SURFACE_FILES = [
  ...new Set(
    MARKETING_SURFACE_ROOTS.flatMap((root) =>
      collectMarketingSurfaceFiles(root),
    ),
  ),
].sort();

const UNSUPPORTED_MARKETING_CLAIMS = [
  { label: "Web3", pattern: /\bweb3\b/i },
  {
    label: "content published on a blockchain",
    pattern:
      /\b(?:publish\w*|publishing|content|zpages?|pages?)\b[^\n.!?]{0,80}\b(?:blockchain|block[- ]chain|on[- ]chain)\b|\b(?:blockchain|block[- ]chain|on[- ]chain)\b[^\n.!?]{0,80}\b(?:publish\w*|publishing|content|zpages?|pages?)\b/iu,
  },
  {
    label: "decentralized publishing/service claim",
    pattern:
      /\b(?:decentral\w*|d[eé]central\w*|descentral\w*)\b[^\n.!?]{0,80}\b(?:platform|service|network|publishing|content|zpages?|pages?)\b|\b(?:platform|service|network|publishing|content|zpages?|pages?)\b[^\n.!?]{0,80}\b(?:decentral\w*|d[eé]central\w*|descentral\w*)\b/iu,
  },
  {
    label: "absolute privacy or surveillance claim",
    pattern:
      /\b(?:complete privacy|complete anonymity|fully encrypted|private by default|without surveillance|no tracking(?: or data collection)?|no one can see|reveal nothing|privacy by design|privacy-first|secure and private)\b/iu,
  },
  {
    label: "unqualified private Zcash/payment claim",
    pattern:
      /\b(?:private|privad[oa]s?|priv[ée]e?s?|confidential\w*|confident\w*)\b[^\n.!?]{0,70}\b(?:zcash|payments?|donations?|pagos?|pagamentos?|paiements?)\b|\b(?:zcash|payments?|donations?|pagos?|pagamentos?|paiements?)\b[^\n.!?]{0,70}\b(?:private|privad[oa]s?|priv[ée]e?s?|confidential\w*|confident\w*)\b/iu,
  },
  {
    label: "anonymous donation claim",
    pattern: /\banonym\w*\s+(?:donat\w*|support\w*|tip\w*)\b/iu,
  },
  {
    label: "unqualified anonymity or identity claim",
    pattern:
      /\b(?:join|speak|support|engage|browse|publish|register|donate)\w*\s+anonym\w*\b|\b(?:anonymous|anonymity)\s+(?:access|browsing|users?|accounts?)\b|\bwithout\s+(?:revealing|sharing)\s+(?:your|their)\s+(?:real[- ]world\s+)?identity\b/iu,
  },
  {
    label: "transparent ranking or guaranteed fair reach",
    pattern:
      /\b(?:content\s+)?ranking\s+algorithms?\s+(?:are|remain)\s+transparent\b|\bfair\s+(?:shot|chance)\s+at\s+reaching\s+(?:their|your|the)\s+audience\b|\bwithout\s+manipulative\s+practices\b/iu,
  },
  {
    label: "absolute platform transparency",
    pattern:
      /\beverything\s+(?:is\s+)?laid\s+bare\b|\b(?:all|every)\s+(?:platform|pricing|revenue[- ]sharing)\s+(?:details|rules|operations?)\s+(?:are\s+)?(?:laid\s+bare|fully\s+(?:transparent|visible))\b/iu,
  },
  {
    label: "perfect accessibility guarantee",
    pattern:
      /\b(?:score|scores|scoring|achieve|achieves|pass|passes?)\s+100\s*%\s+(?:on|in)\s+(?:accessibility|a11y)\b|\b100\s*%\s+(?:accessible|accessibility)\b/iu,
  },
  {
    label: "continuous availability guarantee",
    pattern:
      /\b(?:accessible|available|online|up)\s+24\s*[/-]\s*7\b|\b(?:ensure|ensures|guarantee|guarantees|promise|promises)\b[^\n.!?]{0,80}\b(?:accessible|available|online|up)\s+24\s*[/-]\s*7\b/iu,
  },
  {
    label: "unqualified aspirational product guarantee",
    pattern:
      /\b(?:we['’]?re|we are)\s+building\s+(?:a\s+)?movement\b|\bwe['’]?ll\s+make\s+it\s+happen\b|\b(?:we['’]?re|we are|free2z is)\s+(?:an?\s+)?open\s+(?:book|platform)\b|\b(?:we|free2z)\b[^\n.!?]{0,30}\b(?:actively\s+hire|pay\s+for\s+valuable\s+feedback|host\s+bug\s+bount(?:y|ies))\b|\b(?:optimized|optimised)\s+for\s+(?:speed|ease)\b|\bprovides?\s+effective\s+solutions?\b|\bquality\s+is\s+non[- ]negotiable\b|\b(?:committed|commitment)\s+to\s+accountability\b|\bchampion(?:s)?\s+(?:diversity|free\s+speech)\b|\bmaximum\s+free\s+speech\b|\bpriorit(?:y|iz|is)(?:e|es|ing)\s+user\s+experience\b|\b(?:should|must)\s+be\s+usable\s+by\s+everyone\b/iu,
  },
];

test("marketing denylist covers high-risk guarantee wording", () => {
  const examples = [
    "Our content ranking algorithms are transparent.",
    "Every creator gets a fair shot at reaching their audience.",
    "Everything is laid bare for you to see.",
    "The platform should score 100% on accessibility tests.",
    "Your scheduled stream is accessible 24/7.",
  ];

  for (const example of examples) {
    assert.equal(
      UNSUPPORTED_MARKETING_CLAIMS.some(({ pattern }) => pattern.test(example)),
      true,
      `Denylist did not flag: ${example}`,
    );
  }

  assert.equal(
    UNSUPPORTED_MARKETING_CLAIMS.some(({ pattern }) =>
      pattern.test("We make no 24/7 availability guarantee."),
    ),
    false,
    "A qualified availability limitation should not be treated as a guarantee",
  );

  for (const example of [
    "We are building a movement that thrives.",
    "Tell us what you need and we'll make it happen.",
    "We are an open book and actively hire from our user base.",
    "Our platform is optimized for speed and ease.",
    "Free2Z provides effective solutions for your needs.",
    "Quality is non-negotiable.",
    "Free2Z is committed to accountability.",
    "Free2Z should be usable by everyone.",
  ]) {
    assert.equal(
      UNSUPPORTED_MARKETING_CLAIMS.some(({ pattern }) => pattern.test(example)),
      true,
      `Aspirational denylist did not flag: ${example}`,
    );
  }

  assert.equal(
    UNSUPPORTED_MARKETING_CLAIMS.some(({ pattern }) =>
      pattern.test("This page does not promise an open platform."),
    ),
    false,
    "A qualified open-platform limitation should not be treated as a promise",
  );
});

test("marketing surfaces do not make unsupported architecture or privacy claims", () => {
  const findings = [];

  for (const relative of MARKETING_SURFACE_FILES) {
    const file = path.join(REPO_ROOT, relative);
    if (!fs.existsSync(file)) {
      findings.push(`${relative}: file is missing`);
      continue;
    }
    const source = fs.readFileSync(file, "utf8");
    for (const { label, pattern } of UNSUPPORTED_MARKETING_CLAIMS) {
      if (pattern.test(source)) findings.push(`${relative}: ${label}`);
    }
  }

  assert.deepEqual(
    findings,
    [],
    "Marketing copy contains an unsupported architecture or privacy claim. " +
      "Describe the deployed service and wallet-dependent privacy behavior, " +
      "or add a narrowly justified exception for factual technical language.",
  );
});

test("RealtimeKit language packs match the shipped LangDict", async () => {
  // The packs were carried over from the Dyte UI kit, whose key set is close
  // to but not identical with Cloudflare's fork. A key the fork renamed is
  // invisible: it just silently serves English inside the meeting UI.
  const { defaultLanguage } = await import("@cloudflare/realtimekit-ui");
  const upstream = Object.keys(defaultLanguage);
  const rtkDir = path.join(LOCALES, "rtk");

  for (const locale of APP_LOCALES.filter((l) => l !== "en")) {
    const pack = readCatalog(rtkDir, locale);
    const keys = Object.keys(pack);

    assert.deepEqual(
      keys.filter((k) => !upstream.includes(k)),
      [],
      `rtk/${locale}.json ships keys the UI kit never reads`,
    );
    assert.deepEqual(
      upstream.filter((k) => !keys.includes(k)),
      [],
      `rtk/${locale}.json is missing keys, which silently fall back to English`,
    );
  }
});
