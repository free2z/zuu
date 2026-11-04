import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const result = await build({
  entryPoints: [
    fileURLToPath(
      new URL("../src/lib/components/mdEditor/editorMedia.ts", import.meta.url),
    ),
  ],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  alias: { $lib: fileURLToPath(new URL("../src/lib", import.meta.url)) },
});
const { acceptsEditorMedia, acceptsEditorMediaFile, mediaAccept } =
  await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
  );

test("PDF mode accepts browser aliases and unknown PDF associations, excluding other documents", () => {
  for (const mime of [
    "application/pdf",
    "application/x-pdf",
    "",
    "application/octet-stream",
  ])
    assert.equal(acceptsEditorMedia("document", mime, "report.pdf"), true);
  for (const [mime, name] of [
    ["text/html", "report.pdf"],
    ["", "archive.zip"],
    ["", "notes.docx"],
    ["video/mp4", "film.mp4"],
  ])
    assert.equal(acceptsEditorMedia("document", mime, name), false);
  assert.match(mediaAccept("document"), /application\/pdf/);
  assert.doesNotMatch(mediaAccept("document"), /application\/\*/);
});
test("audio and video accept MIME aliases and exclude other Cloud families", () => {
  assert.equal(acceptsEditorMedia("audio", "audio/x-m4a", "talk.m4a"), true);
  assert.equal(acceptsEditorMedia("audio", "", "talk.opus"), true);
  assert.equal(acceptsEditorMedia("video", "video/x-m4v", "film.m4v"), true);
  assert.equal(acceptsEditorMedia("video", "", "film.webm"), true);
  assert.equal(acceptsEditorMedia("video", "audio/mpeg", "talk.mp3"), false);
  assert.equal(
    acceptsEditorMedia("audio", "application/pdf", "paper.pdf"),
    false,
  );
});

test("neutral-MIME device filenames treat query and fragment characters literally", () => {
  for (const mime of ["", "application/octet-stream"]) {
    assert.equal(acceptsEditorMediaFile("video", mime, "Lesson #1?.mp4"), true);
    assert.equal(acceptsEditorMediaFile("audio", mime, "Track #1?.mp3"), true);
    assert.equal(
      acceptsEditorMediaFile("document", mime, "Chapter #1?.pdf"),
      true,
    );
    assert.equal(
      acceptsEditorMediaFile("video", mime, "Lesson.mp4?notes.txt"),
      false,
    );
    assert.equal(
      acceptsEditorMediaFile("document", mime, "Chapter.pdf#notes.zip"),
      false,
    );
  }
  // Cloud URLs retain their URL semantics, including signed URLs and fragments.
  assert.equal(
    acceptsEditorMedia("video", "", "/uploadz/public/clip.mp4?token=x#t=1"),
    true,
  );
});
