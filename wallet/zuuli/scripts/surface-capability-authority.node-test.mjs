import assert from "node:assert/strict";
import test from "node:test";

import {
  SURFACES,
  assertSurfaceCapabilityAuthority,
  readSurface,
  surfaceFailures,
} from "./surface-capability-authority.mjs";

const CONTENT = SURFACES.find((surface) => surface.directory === "free2z");
const MESSAGING = SURFACES.find((surface) => surface.directory === "e2e2z");

function inputs(surface) {
  const read = readSurface(surface);
  return {
    capabilities: new Map(
      [...read.capabilities].map(([file, capability]) => [
        file,
        structuredClone(capability),
      ]),
    ),
    manifest: read.manifest,
    tauriConfig: structuredClone(read.tauriConfig),
  };
}

function mutateEveryCapability(surface, mutate) {
  const shipped = inputs(surface);
  const mutated = [];
  for (const [file, capability] of shipped.capabilities) {
    const copy = { ...shipped, capabilities: new Map(shipped.capabilities) };
    copy.capabilities.set(file, mutate(structuredClone(capability)));
    mutated.push([file, copy]);
  }
  assert.ok(mutated.length > 0, "every surface must ship at least one capability file");
  return mutated;
}

test("the shipped tree satisfies the reviewed surface contract", () => {
  const result = assertSurfaceCapabilityAuthority();
  assert.equal(result.surfaces, SURFACES.length);
  assert.ok(result.capabilityFiles >= 2 * SURFACES.length);
});

test("the content surface rejects any wallet or messaging grant", () => {
  for (const forbidden of [
    "zcash:default",
    "zcash:allow-sign-challenge",
    "f2zmsg:default",
    "f2zmsg:allow-send-message",
  ]) {
    for (const [file, mutated] of mutateEveryCapability(CONTENT, (capability) => {
      capability.permissions.push(forbidden);
      return capability;
    })) {
      const failures = surfaceFailures(CONTENT, mutated);
      assert.ok(
        failures.some((failure) => failure.includes(forbidden)),
        `${file}: adding ${forbidden} must fail, got ${failures.join("; ") || "(none)"}`,
      );
    }
  }
});

test("a scoped-object grant cannot smuggle a forbidden namespace past the check", () => {
  for (const [, mutated] of mutateEveryCapability(CONTENT, (capability) => {
    capability.permissions.push({
      identifier: "zcash:allow-get-backup-seed-phrase",
      allow: [{ url: "https://free2z.cash/*" }],
    });
    return capability;
  })) {
    assert.ok(
      surfaceFailures(CONTENT, mutated).some((failure) =>
        failure.includes("zcash:allow-get-backup-seed-phrase"),
      ),
    );
  }
});

test("an unreviewed plugin namespace fails rather than passing unjudged", () => {
  for (const [, mutated] of mutateEveryCapability(CONTENT, (capability) => {
    capability.permissions.push("shell:allow-execute");
    return capability;
  })) {
    assert.ok(
      surfaceFailures(CONTENT, mutated).some((failure) =>
        failure.includes("outside the reviewed namespaces"),
      ),
    );
  }
});

test("the messaging surface rejects wallet grants and the blanket messaging grant", () => {
  for (const [, mutated] of mutateEveryCapability(MESSAGING, (capability) => {
    capability.permissions.push("zcash:allow-sign-challenge");
    return capability;
  })) {
    assert.ok(
      surfaceFailures(MESSAGING, mutated).some((failure) =>
        failure.includes("must never grant zcash:*"),
      ),
    );
  }
  for (const [, mutated] of mutateEveryCapability(MESSAGING, (capability) => {
    capability.permissions.push("f2zmsg:default");
    return capability;
  })) {
    assert.ok(
      surfaceFailures(MESSAGING, mutated).some((failure) =>
        failure.includes("must not take the blanket f2zmsg:default"),
      ),
    );
  }
});

test("the messaging surface rejects a command outside the reviewed allowlist", () => {
  for (const [, mutated] of mutateEveryCapability(MESSAGING, (capability) => {
    capability.permissions.push("f2zmsg:allow-set-relay-trust");
    return capability;
  })) {
    assert.ok(
      surfaceFailures(MESSAGING, mutated).some((failure) =>
        failure.includes("not in the reviewed messaging allowlist"),
      ),
    );
  }
});

test("a capability file that grants nothing messaging is caught for the messaging surface", () => {
  for (const [, mutated] of mutateEveryCapability(MESSAGING, (capability) => {
    capability.permissions = capability.permissions.filter(
      (permission) =>
        typeof permission !== "string" || !permission.startsWith("f2zmsg:"),
    );
    return capability;
  })) {
    assert.ok(
      surfaceFailures(MESSAGING, mutated).some((failure) =>
        failure.includes("grants no messaging command at all"),
      ),
    );
  }
});

test("linking a privileged plugin fails even with clean capability files", () => {
  const content = inputs(CONTENT);
  content.manifest += '\ntauri-plugin-zcash = { path = "../../plugins/tauri-plugin-zcash" }\n';
  assert.ok(
    surfaceFailures(CONTENT, content).some((failure) =>
      failure.includes("must not link tauri-plugin-zcash"),
    ),
  );

  const messaging = inputs(MESSAGING);
  messaging.manifest += '\ntauri-plugin-zcash = { path = "../../plugins/tauri-plugin-zcash" }\n';
  assert.ok(
    surfaceFailures(MESSAGING, messaging).some((failure) =>
      failure.includes("must not link tauri-plugin-zcash"),
    ),
  );
});

test("unlinking the messaging plugin fails the messaging surface", () => {
  const messaging = inputs(MESSAGING);
  messaging.manifest = messaging.manifest.replaceAll(
    "\ntauri-plugin-f2zmsg =",
    "\n# tauri-plugin-f2zmsg =",
  );
  assert.ok(
    surfaceFailures(MESSAGING, messaging).some((failure) =>
      failure.includes("must link tauri-plugin-f2zmsg"),
    ),
  );
});

test("the messaging surface must keep frame-src 'none'", () => {
  const messaging = inputs(MESSAGING);
  messaging.tauriConfig.app.security.csp =
    messaging.tauriConfig.app.security.csp.replace(
      "frame-src 'none'",
      "frame-src https:",
    );
  assert.ok(
    surfaceFailures(MESSAGING, messaging).some((failure) =>
      failure.includes("must declare frame-src 'none'"),
    ),
  );
});

test("a renamed application identifier fails", () => {
  const content = inputs(CONTENT);
  content.tauriConfig.identifier = "cash.free2z.zuuli";
  assert.ok(
    surfaceFailures(CONTENT, content).some((failure) =>
      failure.includes("identifier must be cash.free2z.free2z"),
    ),
  );
});

test("an empty capability population is a blindness failure, not a pass", () => {
  const content = inputs(CONTENT);
  content.capabilities = new Map();
  assert.ok(
    surfaceFailures(CONTENT, content).some((failure) =>
      failure.includes("this check has gone blind"),
    ),
  );
});
