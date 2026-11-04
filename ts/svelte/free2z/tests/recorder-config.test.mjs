import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRecorderConfig,
  watermarkOptions,
} from "../src/recorder/config.js";

test("provider config decodes without interpreting HTML or logging values", () => {
  assert.deepEqual(parseRecorderConfig(null), {});
  assert.deepEqual(
    parseRecorderConfig(
      btoa(JSON.stringify({ video_config: { width: 1280 } })),
    ),
    { video_config: { width: 1280 } },
  );
  for (const value of [
    "not base64",
    btoa("null"),
    btoa("[]"),
    "a".repeat(65537),
  ])
    assert.throws(() => parseRecorderConfig(value));
});

test("documented watermark config preserves corner and pixel dimensions", () => {
  const watermark = {
    url: "https://example.com/brand.png",
    position: "right bottom",
    size: { width: 100, height: 20 },
  };
  assert.deepEqual(
    watermarkOptions({ video_config: { watermark } }),
    watermark,
  );
  assert.equal(watermarkOptions({}), null);
  assert.equal(
    watermarkOptions({ watermark: { ...watermark, enabled: false } }),
    null,
  );
  assert.throws(() =>
    watermarkOptions({
      watermark: { ...watermark, url: "javascript:alert(1)" },
    }),
  );
  assert.throws(() =>
    watermarkOptions({
      watermark: { ...watermark, url: "https://user:secret@example.com/logo" },
    }),
  );
  assert.throws(() =>
    watermarkOptions({
      watermark: { ...watermark, position: "left top; color:red" },
    }),
  );
  assert.throws(() =>
    watermarkOptions({ watermark: { ...watermark, size: { width: -1 } } }),
  );
});
