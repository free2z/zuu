import test from "node:test";
import assert from "node:assert/strict";
import { privateCacheControl } from "../src/lib/server/cache-control.js";
test("locale cache policy preserves restrictions and removes shared-cache permission", () => {
  assert.equal(privateCacheControl(null), "private, no-cache");
  assert.equal(
    privateCacheControl("private, no-store"),
    "private, no-store, no-cache",
  );
  assert.equal(
    privateCacheControl("no-store, max-age=0, must-revalidate"),
    "private, no-store, max-age=0, must-revalidate, no-cache",
  );
  assert.equal(
    privateCacheControl("public, max-age=60, s-maxage=300"),
    "private, max-age=60, no-cache",
  );
});
