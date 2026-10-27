/**
 * The anti-drift harness for.
 *
 * `MediaUploader.svelte` shipped its own literal set of five MIME types while
 * the server accepted fourteen. Nothing anywhere failed, because nothing
 * anywhere compared them: the client rejected a PDF in the browser and the
 * backend never saw a request. That is the bug — not the missing PDF, the
 * *silence*.
 *
 * So this file is deliberately paranoid about the derivation chain rather
 * than about PDF:
 *
 *   validation.py ALLOWED_TYPE_EXTENSIONS   (the one source of truth)
 *     == f2z.schemas.ts MimeTypeEnum        (Django -> f2z.yaml -> orval)
 *     == what the client actually gates on
 *
 * The middle link is already CI-enforced twice over (`backend` regenerates
 * f2z.yaml and diffs it, `api-client` regenerates the client and diffs it),
 * and the last link is `Object.values(MimeTypeEnum)` rather than a copy. What
 * is left to check is (a) that the chain really is end-to-end — a future
 * regeneration cannot quietly desync the Python from the schema — and (b) that
 * nobody re-hardcodes a literal list in the client, which is precisely how we
 * got here.
 *
 * The two tables the client *does* copy (browser type aliases, neutral types)
 * have no OpenAPI representation, so they are pinned here by parsing the
 * Python. Copy where we must; contract-test what we copy.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (relative) => readFile(new URL(relative, import.meta.url), "utf8");

const validationSource = await read(
  "../../../../py/free2z/dj/apps/uploads/validation.py",
);
const schemasSource = await read("../src/lib/api/f2z.schemas.ts");
const clientSource = await read(
  "../src/lib/components/media/supportedUploadTypes.ts",
);
const uploaderSource = await read(
  "../src/lib/components/media/MediaUploader.svelte",
);

/** The body of a `NAME... = {` / `}` block, without touching the rest. */
const block = (source, opener, closer) => {
  const start = source.indexOf(opener);
  assert.notEqual(start, -1, `could not find ${JSON.stringify(opener)}`);
  const from = start + opener.length;
  const end = source.indexOf(closer, from);
  assert.notEqual(end, -1, `could not find the end of ${opener}`);
  return source.slice(from, end);
};

/** Quoted strings in a block, minus anything inside a `#` or `//` comment. */
const quoted = (body) =>
  body
    .split("\n")
    .map((line) => line.replace(/(^|\s)(#|\/\/).*$/, ""))
    .join("\n")
    .match(/['"]([^'"\n]*)['"]/g)
    ?.map((token) => token.slice(1, -1)) ?? [];

/** `'image/jpeg': ('.jpg',...)` -> the mapping keys, in file order. */
const pythonDictKeys = (body) =>
  [...body.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]);

const pythonPairs = (body) =>
  Object.fromEntries(
    [...body.matchAll(/^\s*'([^']+)':\s*'([^']+)',/gm)].map((m) => [
      m[1],
      m[2],
    ]),
  );

const tsObjectPairs = (body) =>
  Object.fromEntries(
    [...body.matchAll(/^\s*["']([^"']+)["']:\s*["']([^"']+)["'],/gm)].map(
      (m) => [m[1], m[2]],
    ),
  );

const serverTypes = pythonDictKeys(
  block(
    validationSource,
    "ALLOWED_TYPE_EXTENSIONS: dict[str, tuple[str, ...]] = {",
    "\n}",
  ),
);

const schemaTypes = Object.values(
  tsObjectPairs(block(schemasSource, "export const MimeTypeEnum = {", "\n}")),
);

test("the generated schema enum still equals the server allowlist", () => {
  // If this fails, `f2z.yaml`/`src/lib/api/**` were not regenerated after the
  // Python allowlist changed — or, worse, they were regenerated from a
  // different source. Either way the client is now gating on a stale list.
  assert.deepEqual(
    [...schemaTypes].sort(),
    [...serverTypes].sort(),
    "MimeTypeEnum has drifted from ALLOWED_TYPE_EXTENSIONS — run " +
      "./bin/gen-openapi.sh then `npm run generate:api`",
  );
});

test("PDF is on the allowlist on both sides (#1177)", () => {
  // The regression this whole PR is about, stated plainly. The server has
  // accepted `application/pdf` since; the client rejected it.
  assert.ok(serverTypes.includes("application/pdf"));
  assert.ok(schemaTypes.includes("application/pdf"));
});

test("the client derives its allowlist instead of restating one", () => {
  assert.match(
    clientSource,
    /Object\.values\(MimeTypeEnum\)/,
    "SUPPORTED_UPLOAD_MIME_TYPES must come from the generated enum",
  );

  // The actual failure mode: someone adds "just one" literal type back. Any
  // media/video/audio MIME literal outside the alias table is a new hand-kept
  // list in disguise.
  const aliasBody = block(
    clientSource,
    "export const DECLARED_TYPE_ALIASES: Readonly<Record<string, string>> = {",
    "\n}",
  );
  const outsideAliases = clientSource.replace(aliasBody, "");
  const literals = quoted(outsideAliases).filter((value) =>
    /^(image|video|audio|application)\/[a-z0-9.+-]+$/.test(value),
  );
  const allowed = new Set([
    // NEUTRAL_DECLARED_TYPES — a "no claim" marker, not a supported type.
    "application/octet-stream",
    "binary/octet-stream",
    "application/unknown",
    "application/force-download",
  ]);
  assert.deepEqual(
    literals.filter((value) => !allowed.has(value)),
    [],
    "hard-coded MIME literals reappeared in supportedUploadTypes.ts",
  );
});

test("the picker hint is wider than the gate, never narrower", () => {
  // Codex review of, finding 2. `accept` is matched by the OS against
  // ITS extension->MIME table, which disagrees with ours: `.heif` is
  // `image/heif` on Linux/Android, `.opus` is `audio/opus`, and Windows maps
  // `.heic` to nothing. A canonical-types-only `accept` therefore HIDES files
  // the server accepts — the  bug again, moved into the file picker
  // where it is even quieter. The media families are widened; the JS gate and
  // the server's byte sniff still decide.
  const accept = block(
    clientSource,
    "export const UPLOAD_ACCEPT_ATTRIBUTE = [",
    '].join(",");',
  );
  assert.match(accept, /WIDENED_FAMILIES/);
  const widened = quoted(
    block(clientSource, "const WIDENED_FAMILIES = new Set([", "]);"),
  );
  assert.deepEqual(widened.sort(), ["audio", "image", "video"]);
  // `application/*` would mean "any file" and is deliberately not widened, so
  // every allowlisted application/* type must still be named exactly.
  const applicationTypes = serverTypes.filter((t) =>
    t.startsWith("application/"),
  );
  assert.deepEqual(applicationTypes, ["application/pdf"]);
});

test("the uploader no longer carries its own allowlist", () => {
  assert.doesNotMatch(uploaderSource, /supportedMediaTypes/);
  assert.match(uploaderSource, /isSupportedUploadFile/);
  // The `accept=` attribute is the other half of the client gate; a literal
  // there re-creates the bug for the file picker even if the code path is fixed.
  assert.match(uploaderSource, /accept=\{UPLOAD_ACCEPT_ATTRIBUTE\}/);
  assert.doesNotMatch(uploaderSource, /accept="image\//);
});

test("browser type aliases match the server's normalization table", () => {
  const server = pythonPairs(
    block(validationSource, "DECLARED_TYPE_ALIASES = {", "\n}"),
  );
  const client = tsObjectPairs(
    block(
      clientSource,
      "export const DECLARED_TYPE_ALIASES: Readonly<Record<string, string>> = {",
      "\n}",
    ),
  );
  // An alias the server knows but the client does not is a false rejection —
  // an iPhone photo declared `image/heif`, an MP3 declared `audio/mp3`. An
  // alias only the client knows is a doomed upload. Both are drift.
  assert.deepEqual(client, server);
});

test("neutral declared types match the server's", () => {
  const server = quoted(
    block(validationSource, "NEUTRAL_DECLARED_TYPES = frozenset({", "})"),
  );
  const client = quoted(
    block(
      clientSource,
      "export const NEUTRAL_DECLARED_TYPES: ReadonlySet<string> = new Set([",
      "]);",
    ),
  );
  // The empty string is the important one: Chrome on Windows reports "" for a
  //.heic, and a client that rejects "" rejects the file the server would
  // happily sniff and accept.
  assert.ok(client.includes(""));
  assert.deepEqual([...client].sort(), [...server].sort());
});

test("active document types are absent from both sides (#962)", () => {
  for (const active of [
    "image/svg+xml",
    "text/html",
    "application/xhtml+xml",
    "application/xml",
    "text/javascript",
  ]) {
    assert.ok(
      !serverTypes.includes(active),
      `${active} must never be server-allowlisted`,
    );
    assert.ok(
      !schemaTypes.includes(active),
      `${active} must never reach the client allowlist`,
    );
  }
});

test("the document preview does not embed uploaded bytes on the app origin", async () => {
  // A PDF renders inline from the cookie-bearing free2z.cash origin today
  // (nginx sets no Content-Disposition). Wrapping it in an <iframe>/<object>
  // inside the app shell would add a *second* inline surface, on a page that
  // already holds the session — exactly the boundary  is about. The
  // document state offers download and an explicit new-tab open instead.
  const raw = await read(
    "../src/lib/components/media/MediaPreviewDialog.svelte",
  );
  // Strip HTML comments first — the markup comment explaining this decision
  // names the very tags we are forbidding.
  const preview = raw.replace(/<!--[\s\S]*?-->/g, "");
  assert.doesNotMatch(preview, /<iframe/);
  assert.doesNotMatch(preview, /<object/);
  assert.doesNotMatch(preview, /<embed/);
  assert.match(preview, /data-preview-kind="document"/);
  assert.match(preview, /data-preview-action="download"/);
});
