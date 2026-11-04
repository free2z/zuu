import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/lib/components/auth/OTPModal.svelte", import.meta.url),
  "utf8",
);

test("OTP trouble affordance is a support mail link, not a dead action", () => {
  const marker = "<!-- Trouble Link -->";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, "OTP trouble affordance is missing");

  const end = source.indexOf("    </form>", start);
  assert.notEqual(end, -1, "OTP form is missing");
  const troubleSection = source.slice(start, end);
  assert.match(
    troubleSection,
    /<Button[\s\S]*?href="mailto:help@free2z\.com"[\s\S]*?troubleWith2FA/,
  );
  assert.doesNotMatch(troubleSection, /\bonclick\s*=/);
  assert.doesNotMatch(troubleSection, /TODO|console\.log/);
});
