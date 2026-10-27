import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

/**
 * No browser WRITE may bypass the shared request paths.
 *
 *  bounded every write that goes through `apiFetch` (`config.ts`) or the
 * orval `customInstance` (`mutator.ts`) and taught both to carry the server's
 * reason. A write sent with a raw `fetch(` got none of it: the converse
 * composer, comment posting, comment votes, login, logout and the recovery
 * emails all used one, so a request the server never answered left its
 * spinner up forever and a refusal was shown as "Failed to post comment".
 *
 * This scans every browser module under `src/` and fails on:
 *   - a `fetch(` whose method is not provably GET/HEAD/OPTIONS — a literal
 *     write verb, a computed `method`, a spread init, or an init that is not
 *     an object literal (we cannot see what it carries);
 *   - `new XMLHttpRequest` and `navigator.sendBeacon(` (both can write);
 * outside {@link ALLOWED}, where each entry says why it is the shared path.
 *
 * SERVER modules (`src/lib/server/**`, `*.server.*`, `+server.*`, `hooks.*`)
 * are out of scope: they are SSR reads and proxies that never run in a
 * browser, and  is about what a person is left staring at.
 *
 * Deliberately NOT caught (a cheap guard, not a type system): `fetch` handed
 * around as a value (`fetchImpl: typeof fetch = fetch`) and called under
 * another name. Route a new write through `apiFetch` rather than working
 * around this test.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const srcDir = path.join(root, "src");

/** path (relative to the package) -> why it may send a raw write. */
const ALLOWED = new Map([
  [
    "src/lib/api/config.ts",
    "apiFetch itself: CSRF, credentials and the write bound (#2046)",
  ],
  [
    "src/lib/api/mutator.ts",
    "the orval customInstance: the generated client's one transport (#2046)",
  ],
  [
    "src/lib/components/media/uploadRequest.ts",
    "the upload transport: XHR for progress, stall watch + response bound (#2060)",
  ],
  [
    "src/lib/components/media/MediaUploader.svelte",
    "multi-file uploader: XHR for per-file progress, bounded by uploadRequest's watchUploadStall (#2060)",
  ],
]);

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isServerModule(rel) {
  return (
    rel.startsWith("src/lib/server/") ||
    /(^|\/)\+server\.[jt]s$/.test(rel) ||
    /\.server\.[jt]s$/.test(rel) ||
    /^src\/hooks(\.[a-z]+)?\.[jt]s$/.test(rel)
  );
}

/**
 * Blank out comments and the CONTENTS of string/template/regex literals with
 * spaces, keeping every offset. Template `${...}` expressions stay code.
 * Returns the masked text and whether the lexer ended cleanly — an
 * unterminated literal means the lexer got confused, and the test says so
 * rather than trusting a scan it cannot vouch for.
 *
 * @param {string} src
 */
export function maskSource(src) {
  const out = src.split("");
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== "\n") out[k] = " ";
  };
  /** Stack of open template literals; each entry is the brace depth of its `${`. */
  const templates = [];
  let braceDepth = 0;
  let lastSignificant = "";
  let lastWord = "";
  let i = 0;
  const n = src.length;

  const regexCanStart = () =>
    lastSignificant === "" ||
    "(,=:[!&|?{};+-*%<>~^".includes(lastSignificant) ||
    [
      "return",
      "typeof",
      "case",
      "in",
      "of",
      "delete",
      "void",
      "throw",
    ].includes(lastWord);

  /** Scan template text from `i` (just past "`" or "}") to "`" or "${". */
  const scanTemplateText = () => {
    const start = i;
    while (i < n) {
      if (src[i] === "\\") {
        i += 2;
        continue;
      }
      if (src[i] === "`") {
        blank(start, i);
        i += 1;
        templates.pop();
        lastSignificant = "`";
        return true;
      }
      if (src[i] === "$" && src[i + 1] === "{") {
        blank(start, i);
        i += 2;
        braceDepth += 1;
        templates[templates.length - 1] = braceDepth;
        lastSignificant = "{";
        return true;
      }
      i += 1;
    }
    return false;
  };

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) return { masked: out.join(""), clean: false };
      blank(i, end + 2);
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") {
        j += src[j] === "\\" ? 2 : 1;
      }
      if (src[j] !== c) return { masked: out.join(""), clean: false };
      blank(i + 1, j);
      i = j + 1;
      lastSignificant = c;
      lastWord = "";
      continue;
    }
    if (c === "`") {
      i += 1;
      templates.push(-1);
      if (!scanTemplateText()) return { masked: out.join(""), clean: false };
      lastWord = "";
      continue;
    }
    if (c === "/" && regexCanStart()) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) break;
        j += 1;
      }
      if (src[j] !== "/") return { masked: out.join(""), clean: false };
      blank(i + 1, j);
      i = j + 1;
      lastSignificant = "/";
      lastWord = "";
      continue;
    }
    if (c === "{") braceDepth += 1;
    if (c === "}") {
      if (templates.length && templates[templates.length - 1] === braceDepth) {
        braceDepth -= 1;
        i += 1;
        if (!scanTemplateText()) return { masked: out.join(""), clean: false };
        continue;
      }
      braceDepth -= 1;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(src[j])) j += 1;
      lastWord = src.slice(i, j);
      lastSignificant = "a";
      i = j;
      continue;
    }
    if (!/\s/.test(c)) {
      lastSignificant = c;
      lastWord = "";
    }
    i += 1;
  }
  return { masked: out.join(""), clean: templates.length === 0 };
}

/**
 * The `<script>` bodies of a `.svelte` file, at their original offsets
 * (markup becomes spaces). Markup text is prose — "don't" is not a string —
 * so it is not lexed; a `fetch(` in a markup expression is still reported,
 * as unprovable.
 *
 * @param {string} src
 */
function svelteScripts(src) {
  const out = src.replace(/[^\n]/g, " ").split("");
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
  let match;
  let markup = src;
  while ((match = scriptRe.exec(src))) {
    const bodyStart = match.index + match[0].indexOf(">") + 1;
    for (let k = 0; k < match[1].length; k += 1) {
      out[bodyStart + k] = src[bodyStart + k];
    }
    markup =
      markup.slice(0, match.index) +
      " ".repeat(match[0].length) +
      markup.slice(match.index + match[0].length);
  }
  return { script: out.join(""), markup };
}

/** Split the text of an argument list on its top-level commas. */
function topLevelArgs(text) {
  /** @type {{text: string, start: number}[]} */
  const args = [];
  let depth = 0;
  let start = 0;
  const push = (end) => {
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed) args.push({ text: trimmed, start: start + lead });
  };
  for (let k = 0; k < text.length; k += 1) {
    const c = text[k];
    if ("([{".includes(c)) depth += 1;
    else if (")]}".includes(c)) depth -= 1;
    else if (c === "," && depth === 0) {
      push(k);
      start = k + 1;
    }
  }
  push(text.length);
  return args;
}

/**
 * Classify one `fetch(` init argument. `original` is the same span of the
 * unmasked source, so a string literal's value can be read back.
 *
 * @returns {"read" | string} "read", or why it is (or may be) a write.
 */
function classifyInit(masked, original) {
  if (masked === undefined) return "read";
  if (!masked.startsWith("{") || !masked.endsWith("}")) {
    return "init is not an object literal, so its method cannot be seen";
  }
  // The object's own top-level properties. Nested `headers: {...}` stay
  // inside one property. Structure is read from the masked text (comments
  // and literal contents blanked); keys and values from the original.
  const spans = [];
  let depth = 0;
  let start = 1;
  for (let k = 1; k < masked.length - 1; k += 1) {
    const c = masked[k];
    if ("([{".includes(c)) depth += 1;
    else if (")]}".includes(c)) depth -= 1;
    else if (c === "," && depth === 0) {
      spans.push([start, k]);
      start = k + 1;
    }
  }
  spans.push([start, masked.length - 1]);

  let verdict = "read";
  for (const [from, to] of spans) {
    const piece = masked.slice(from, to);
    const shape = piece.trim();
    if (!shape) continue;
    const lead = piece.search(/\S/);
    const text = original.slice(from + lead, from + lead + shape.length);
    // A spread can carry, or override, a method -- before or after ours.
    if (shape.startsWith("...")) {
      return "init spreads another object, so its method cannot be seen";
    }
    if (shape.startsWith("[")) {
      return "init has a computed key, so its method cannot be seen";
    }
    // `method`, `"method"`, `'method'`: read from the original, because
    // masking blanks a quoted key's letters.
    const key = /^(["'`]?)method\1(?=\s*(?::|$))/.exec(text);
    if (!key) continue;
    const rest = text.slice(key[0].length).trim();
    if (!rest.startsWith(":")) {
      return "method is a shorthand property (computed)";
    }
    const literal = /^:\s*(["'`])([A-Za-z]*)\1$/.exec(rest);
    if (!literal) return "method is computed, not a string literal";
    const verb = literal[2].toUpperCase();
    // No early return: a later duplicate key wins in JS.
    verdict = READ_METHODS.has(verb) ? "read" : `method is ${verb}`;
  }
  return verdict;
}

/**
 * Every raw request in one module that is (or may be) a write.
 *
 * @param {string} source
 * @param {{ svelte?: boolean }} [options]
 * @returns {{ findings: {line: number, reason: string}[], clean: boolean }}
 */
export function scanForRawWrites(source, { svelte = false } = {}) {
  let code = source;
  let markup = "";
  if (svelte) ({ script: code, markup } = svelteScripts(source));
  const { masked, clean } = maskSource(code);
  const findings = [];
  const lineOf = (offset) => source.slice(0, offset).split("\n").length;

  const callRe =
    /(?<![\w$.])(?:(?:window|globalThis|self)\s*\.\s*)?fetch\s*\(/g;
  let m;
  while ((m = callRe.exec(masked))) {
    const open = m.index + m[0].length;
    let depth = 1;
    let k = open;
    while (k < masked.length && depth > 0) {
      if (masked[k] === "(") depth += 1;
      else if (masked[k] === ")") depth -= 1;
      k += 1;
    }
    const inner = masked.slice(open, k - 1);
    const innerOriginal = code.slice(open, k - 1);
    const [input, init] = topLevelArgs(inner);
    // The masked and original texts share offsets, so the init's original
    // text (string literals intact) is the same span.
    const initOriginal =
      init && innerOriginal.slice(init.start, init.start + init.text.length);
    let reason = classifyInit(init?.text, initOriginal);
    if (reason === "read" && /^new\s+Request\b/.test(input?.text ?? "")) {
      reason = "a Request object may carry its own method";
    }
    if (reason !== "read") findings.push({ line: lineOf(m.index), reason });
  }

  const xhrRe = /\bnew\s+XMLHttpRequest\b/g;
  while ((m = xhrRe.exec(masked))) {
    findings.push({ line: lineOf(m.index), reason: "new XMLHttpRequest" });
  }
  const beaconRe = /\bsendBeacon\s*\(/g;
  while ((m = beaconRe.exec(masked))) {
    findings.push({ line: lineOf(m.index), reason: "sendBeacon is a POST" });
  }
  const markupFetch = /(?<![\w$.])fetch\s*\(/g;
  while ((m = markupFetch.exec(markup))) {
    findings.push({
      line: lineOf(m.index),
      reason: "fetch( in markup: its method cannot be checked",
    });
  }
  return { findings, clean };
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(svelte|[cm]?[jt]s)$/.test(entry.name)) yield full;
  }
}

async function scanTree() {
  const byFile = new Map();
  const unclean = [];
  for await (const full of walk(srcDir)) {
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (/\.(test|spec)\.[cm]?[jt]s$/.test(rel) || isServerModule(rel)) continue;
    const source = await readFile(full, "utf8");
    const { findings, clean } = scanForRawWrites(source, {
      svelte: rel.endsWith(".svelte"),
    });
    if (!clean) unclean.push(rel);
    if (findings.length) byFile.set(rel, findings);
  }
  return { byFile, unclean };
}

test("no browser module sends a raw write outside the shared request paths", async () => {
  const { byFile, unclean } = await scanTree();
  assert.deepEqual(
    unclean,
    [],
    "the lexer lost track of a literal in these files, so their scan cannot be trusted; teach maskSource the construct",
  );
  const offenders = [...byFile]
    .filter(([rel]) => !ALLOWED.has(rel))
    .flatMap(([rel, findings]) =>
      findings.map(({ line, reason }) => `${rel}:${line} — ${reason}`),
    );
  assert.deepEqual(
    offenders,
    [],
    "route these writes through apiFetch ($lib/api/config) or the generated client, " +
      "which bound them (#2046) and carry the server's reason (readApiError, #2052). " +
      "Uploads go through uploadRequest (#2060).",
  );
});

test("every allow-list entry still matches something (no inert exemptions)", async () => {
  const { byFile } = await scanTree();
  for (const [rel, why] of ALLOWED) {
    assert.ok(
      byFile.has(rel),
      `${rel} is allow-listed ("${why}") but sends no raw write any more; delete its entry`,
    );
  }
});

// ---------------------------------------------------------------------------
// Negative controls: the scanner itself. Each would-be offender must be
// caught, and each read must not be — otherwise a green run above is empty.

const flagged = (source, svelte = false) =>
  scanForRawWrites(source, { svelte }).findings.map((f) => f.reason);

test("scanner flags literal write verbs, computed methods, spreads and opaque inits", () => {
  assert.deepEqual(
    flagged(`await fetch("/api/x", { method: "POST", body });`),
    ["method is POST"],
  );
  assert.deepEqual(flagged(`fetch(u, { method: 'delete' })`), [
    "method is DELETE",
  ]);
  assert.deepEqual(flagged("fetch(`${base}/x`, { method: `PATCH` })"), [
    "method is PATCH",
  ]);
  assert.deepEqual(flagged(`fetch(u, { method: verb })`), [
    "method is computed, not a string literal",
  ]);
  assert.deepEqual(flagged(`fetch(u, { method })`), [
    "method is a shorthand property (computed)",
  ]);
  assert.deepEqual(flagged(`fetch(u, { ...init, signal })`), [
    "init spreads another object, so its method cannot be seen",
  ]);
  // Both from the codex review: a quoted key, and a spread that overrides
  // an earlier GET.
  assert.deepEqual(flagged(`fetch(u, { "method": "POST", body })`), [
    "method is POST",
  ]);
  assert.deepEqual(flagged(`fetch(u, { 'method': 'PUT' })`), ["method is PUT"]);
  assert.deepEqual(
    flagged(`fetch(u, { method: "GET", ...{ method: "POST", body } })`),
    ["init spreads another object, so its method cannot be seen"],
  );
  assert.deepEqual(flagged(`fetch(u, { method: "GET", method: "DELETE" })`), [
    "method is DELETE",
  ]);
  assert.deepEqual(flagged(`fetch(u, { [key]: "POST" })`), [
    "init has a computed key, so its method cannot be seen",
  ]);
  assert.deepEqual(flagged(`fetch(u, { method: ok ? "GET" : "POST" })`), [
    "method is computed, not a string literal",
  ]);
  assert.deepEqual(flagged(`fetch(u, init)`), [
    "init is not an object literal, so its method cannot be seen",
  ]);
  assert.deepEqual(flagged(`window.fetch(u, { method: "PUT" })`), [
    "method is PUT",
  ]);
  assert.deepEqual(flagged(`globalThis . fetch(u, { method: "PUT" })`), [
    "method is PUT",
  ]);
  assert.deepEqual(flagged(`fetch(new Request(u, { method: "POST" }))`), [
    "a Request object may carry its own method",
  ]);
  assert.deepEqual(flagged(`const x = new XMLHttpRequest();`), [
    "new XMLHttpRequest",
  ]);
  assert.deepEqual(flagged(`navigator.sendBeacon("/api/x", body)`), [
    "sendBeacon is a POST",
  ]);
});

test("scanner leaves reads, comments, strings and other callees alone", () => {
  assert.deepEqual(flagged(`fetch(u)`), []);
  assert.deepEqual(flagged(`fetch(u, { credentials: "include" })`), []);
  assert.deepEqual(
    flagged(`fetch(u, { method: "GET", headers: { method: "POST" } })`),
    [],
  );
  assert.deepEqual(flagged(`fetch(u, { method: "HEAD", signal })`), []);
  assert.deepEqual(flagged(`// fetch(u, { method: "POST" })`), []);
  assert.deepEqual(flagged(`/* fetch(u, { method: "POST" }) */`), []);
  assert.deepEqual(flagged(`const s = 'fetch(u, { method: "POST" })';`), []);
  assert.deepEqual(flagged(`apiFetch(u, { method: "POST" })`), []);
  assert.deepEqual(flagged(`options.fetch(u, { method: "POST" })`), []);
  // A regex literal holding a quote must not open a string.
  assert.deepEqual(flagged(`const r = /["']/; fetch(u, { method: "POST" });`), [
    "method is POST",
  ]);
  // A template expression is code: the call inside it is found.
  assert.deepEqual(
    flagged("const t = `${await fetch(u, { method: 'POST' })}`;"),
    ["method is POST"],
  );
});

test("scanner reads .svelte scripts, not prose, and reports markup fetches", () => {
  const svelteSource = `<script lang="ts">
  const ok = await fetch(u);
</script>

<p>Don't panic: it's fine.</p>
`;
  const result = scanForRawWrites(svelteSource, { svelte: true });
  assert.equal(
    result.clean,
    true,
    "an apostrophe in markup confused the lexer",
  );
  assert.deepEqual(result.findings, []);

  const writing = `<script>
  async function go() {
    await fetch("/api/x", { method: "POST" });
  }
</script>
<button onclick={() => fetch(u, init)}>Go</button>`;
  assert.deepEqual(flagged(writing, true), [
    "method is POST",
    "fetch( in markup: its method cannot be checked",
  ]);
  assert.deepEqual(
    scanForRawWrites(writing, { svelte: true }).findings.map((f) => f.line),
    [3, 6],
  );
});
