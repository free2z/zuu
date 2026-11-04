// Check the built plain legal pages (/docs/plain/…), which the sign-up sheet
// an SDK app opens links to. Every Free2Z page an SDK app opens must be
// commerce-free (the store line, zuu docs/free2z/sdk/INTEGRATION.md), and
// these pages are reached from one.
//
//   node scripts/check-legal-plain.mjs docsbuild   # check a build
//   node scripts/check-legal-plain.mjs --self-test # each rule fails alone
//
// Rules, per page:
//   nav        no navbar or footer
//   link       every <a href> is /docs/plain/…, mailto: or #…
//   asset      nothing fetched from another origin
//   noindex    <meta name="robots" content="noindex">
//   canonical  rel=canonical names a /docs/legal/… page that exists in the build
//   vocabulary no purchase vocabulary in the rendered text, except the exact
//              legal phrases in LEGAL_PHRASES below
// and for the build: exactly the allow-listed documents were emitted, and the
// plain Terms page carries the Terms heading.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ALLOWED = createRequire(import.meta.url)("../src/legal-plain/allowlist.js");

// Purchase vocabulary.
const VOCABULARY = /\bbuy(?:ing|s)?\b|\bbuy_2z\b|\bpurchas\w*|\btop[\s-]?up\b|\bprices?\b|\bpricing\b|\$|\bmemo\b/gi;

// Legal text that names purchases without being a path to one: the Terms'
// own list of the documents it incorporates (rendered unlinked here), and
// standard clauses. Exact phrases; a new occurrence anywhere else fails.
const LEGAL_PHRASES = [
  "2Z Credits and Purchases",
  "Purchases, Delivery and Refunds",
  "to terminate or to suspend your access to any purchased products or services",
  "SET ITS PRICES",
  "Records of purchases you make",
  "what was purchased",
];

function text(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<head\b[\s\S]*?<\/head>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
}

export function pageProblems(path, html, buildRoot) {
  const problems = [];
  if (/class="[^"]*\bnavbar\b/i.test(html) || /<footer\b/i.test(html)) {
    problems.push("nav: has site navigation");
  }
  for (const [, href] of html.matchAll(/<(?:a|area)\b[^>]*\shref="([^"]*)"/gi)) {
    if (!/^(\/docs\/plain\/|mailto:|#)/.test(href)) problems.push(`link: links out to ${href}`);
  }
  for (const [tag] of html.matchAll(/<(?:script|link|img|iframe|source|video|audio)\b[^>]*>/gi)) {
    if (/^<link\b/i.test(tag) && /\brel="(?:alternate|canonical)"/i.test(tag)) continue;
    const url = tag.match(/\s(?:src|href|srcset)="([^"]*)"/i)?.[1] ?? "";
    if (/^(https?:)?\/\//i.test(url)) problems.push(`asset: loads ${url}`);
  }
  if (!/<meta\b[^>]*name="robots"[^>]*content="noindex"/i.test(html)) {
    problems.push("noindex: page is indexable");
  }
  const canonical = html.match(/<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"/i)?.[1];
  const canonicalPath = canonical ? new URL(canonical, "https://example.test").pathname : "";
  if (!canonicalPath.startsWith("/docs/legal/")) {
    problems.push(`canonical: ${canonical ?? "missing"} is not a /docs/legal/ page`);
  } else if (buildRoot) {
    const target = join(buildRoot, canonicalPath.replace(/^\/docs\//, ""), "index.html");
    const flat = join(buildRoot, `${canonicalPath.replace(/^\/docs\//, "").replace(/\/$/, "")}.html`);
    if (!existsSync(target) && !existsSync(flat)) {
      problems.push(`canonical: ${canonicalPath} does not exist in the build`);
    }
  }
  let body = text(html);
  for (const phrase of LEGAL_PHRASES) body = body.split(phrase).join(" ");
  const words = [...new Set([...body.matchAll(VOCABULARY)].map((m) => m[0]))];
  if (words.length) problems.push(`vocabulary: ${words.join(", ")}`);
  return problems.map((problem) => `${path}: ${problem}`);
}

/** The route each allow-listed file is published at: its front-matter slug's
 * last segment, else its name without the NN- prefix and .md. */
export function expectedPages(sourceRoot) {
  return ALLOWED.map((name) => {
    const source = readFileSync(join(sourceRoot, name), "utf8");
    const slug = source.match(/^---\n[\s\S]*?^slug:\s*(\S+)\s*$[\s\S]*?^---/m)?.[1];
    if (slug) return slug.replace(/^\/+|\/+$/g, "").split("/").pop();
    return name.replace(/^\d{2}-/, "").replace(/\.md$/, "");
  }).sort();
}

export function checkBuild(buildRoot, sourceRoot = "docs/legal") {
  const plainRoot = join(buildRoot, "plain");
  const built = readdirSync(plainRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const pages = built.map((name) => join(plainRoot, name, "index.html"));
  const problems = [];
  const expected = expectedPages(sourceRoot);
  if (JSON.stringify(built) !== JSON.stringify(expected)) {
    problems.push(`build: plain pages ${JSON.stringify(built)} are not the allow-list ${JSON.stringify(expected)}`);
  }
  for (const page of pages) {
    problems.push(...pageProblems(page, readFileSync(page, "utf8"), buildRoot));
  }
  const terms = join(plainRoot, "legal", "index.html");
  if (!existsSync(terms) ||
      !/<h1\b[^>]*>[\s\S]*?terms of service agreement[\s\S]*?<\/h1>/i.test(readFileSync(terms, "utf8"))) {
    problems.push("build: no plain Terms page with the Terms heading at plain/legal/");
  }
  return problems;
}

// One clean page, and one page per rule that breaks ONLY that rule.
const CLEAN =
  '<html><head><meta name="robots" content="noindex"><link rel="canonical" href="/docs/legal/">' +
  '<link rel="stylesheet" href="/docs/assets/css/styles.css"></head>' +
  '<body><main><article><h1>Terms of Service Agreement</h1><p>See the ' +
  '<a href="/docs/plain/privacy-policy">Privacy Policy</a>, 2Z Credits and Purchases, ' +
  'or <a href="mailto:help@free2z.com">write to us</a>.</p></article></main></body></html>';

const BROKEN = {
  nav: CLEAN.replace("<main>", '<nav class="navbar"></nav><main>'),
  link: CLEAN.replace("/docs/plain/privacy-policy", "/docs/getting-started/tuzis"),
  // The same rule for an image-map link, which carries no text.
  area: CLEAN.replace("</article>", '<map><area href="/docs/getting-started/tuzis" alt=""></map></article>'),
  asset: CLEAN.replace("/docs/assets/css/styles.css", "https://fonts.example/x.css"),
  noindex: CLEAN.replace('<meta name="robots" content="noindex">', ""),
  canonical: CLEAN.replace('href="/docs/legal/"', 'href="/docs/legal/no-such-page"'),
  vocabulary: CLEAN.replace("write to us", "buy 2Z for $5 with memo buy_2z"),
};

function selfTest() {
  const root = mkdtempSync(join(tmpdir(), "legal-plain-"));
  try {
    mkdirSync(join(root, "legal"), { recursive: true });
    writeFileSync(join(root, "legal", "index.html"), "<h1>Terms</h1>");
    const clean = pageProblems("clean", CLEAN, root);
    if (clean.length) throw new Error(`self-test: the clean page failed: ${clean.join("; ")}`);
    for (const [rule, html] of Object.entries(BROKEN)) {
      const problems = pageProblems(rule, html, root);
      const expected = rule === "area" ? "link" : rule;
      const rules = new Set(problems.map((p) => p.split(": ")[1]));
      if (rules.size !== 1 || !rules.has(expected)) {
        throw new Error(`self-test: breaking "${rule}" reported ${JSON.stringify(problems)}`);
      }
    }
    console.log(`check-legal-plain self-test: clean page passes; each of ${Object.keys(BROKEN).length} rules fails alone`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const arg = process.argv[2];
const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (!isMain) {
  // Imported (for a test or a probe): no CLI.
} else if (arg === "--self-test") {
  selfTest();
} else if (arg) {
  const problems = checkBuild(arg);
  if (problems.length) {
    for (const problem of problems) console.error(`::error file=docs/about-free2z::${problem}`);
    process.exit(1);
  }
  console.log(`check-legal-plain: ${ALLOWED.length} plain pages are commerce-free`);
} else {
  console.error("usage: check-legal-plain.mjs <docsbuild> | --self-test");
  process.exit(2);
}
