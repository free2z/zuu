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
    packageJson: structuredClone(read.packageJson),
    entrypoint: read.entrypoint,
    sources: new Map(read.sources),
  };
}

/// Add one fabricated production source to an otherwise shipped tree.
function withSource(surface, name, source) {
  const copy = inputs(surface);
  copy.sources.set(`wallet/${surface.directory}/src/${name}`, source);
  return copy;
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

// ---------------------------------------------------------------------------
// #918: the scoped `http` grant, and the negative control that keeps it honest.
//
// `http` is in free2z's reviewed namespaces now. What was reviewed is not the
// namespace but the SCOPE, so the identifier alone must still fail.
// ---------------------------------------------------------------------------

test("an unscoped http:default still fails on the content surface", () => {
  for (const [file, mutated] of mutateEveryCapability(CONTENT, (capability) => {
    capability.permissions = capability.permissions.filter(
      (permission) =>
        typeof permission === "string" || permission.identifier !== "http:default",
    );
    capability.permissions.push("http:default");
    return capability;
  })) {
    const failures = surfaceFailures(CONTENT, mutated);
    assert.ok(
      failures.some((failure) =>
        failure.includes("must be a scoped object with an allow list"),
      ),
      `${file}: a bare http:default must fail, got ${failures.join("; ") || "(none)"}`,
    );
  }
});

test("a scoped http grant with an empty allow list fails", () => {
  for (const [, mutated] of mutateEveryCapability(CONTENT, (capability) => {
    capability.permissions = capability.permissions.map((permission) =>
      typeof permission !== "string" && permission.identifier === "http:default"
        ? { identifier: "http:default", allow: [] }
        : permission,
    );
    return capability;
  })) {
    assert.ok(
      surfaceFailures(CONTENT, mutated).some((failure) =>
        failure.includes("must carry a non-empty allow list"),
      ),
    );
  }
});

test("a wildcard or non-https http scope entry fails", () => {
  for (const url of [
    "*://*",
    "https://*",
    "https://*/*",
    "http://free2z.cash/*",
    "https://free2z.cash",
    "https://free2z.cash:8443/*",
    "https://user@free2z.cash/*",
  ]) {
    for (const [, mutated] of mutateEveryCapability(CONTENT, (capability) => {
      capability.permissions = capability.permissions.map((permission) =>
        typeof permission !== "string" && permission.identifier === "http:default"
          ? { identifier: "http:default", allow: [{ url }] }
          : permission,
      );
      return capability;
    })) {
      assert.ok(
        surfaceFailures(CONTENT, mutated).some((failure) =>
          failure.includes("may only allow"),
        ),
        `${url} must be refused as an http scope entry`,
      );
    }
  }
});

test("an http scope entry the app's own connect-src does not admit fails", () => {
  for (const [, mutated] of mutateEveryCapability(CONTENT, (capability) => {
    capability.permissions = capability.permissions.map((permission) =>
      typeof permission !== "string" && permission.identifier === "http:default"
        ? {
            identifier: "http:default",
            allow: [{ url: "https://free2z.cash/*" }, { url: "https://evil.example/*" }],
          }
        : permission,
    );
    return capability;
  })) {
    assert.ok(
      surfaceFailures(CONTENT, mutated).some((failure) =>
        failure.includes("connect-src does not admit"),
      ),
    );
  }
});

test("reviewing http for the content surface did not review it for the messaging one", () => {
  for (const [, mutated] of mutateEveryCapability(MESSAGING, (capability) => {
    capability.permissions.push({
      identifier: "http:default",
      allow: [{ url: "https://free2z.cash/*" }],
    });
    return capability;
  })) {
    assert.ok(
      surfaceFailures(MESSAGING, mutated).some((failure) =>
        failure.includes("outside the reviewed namespaces"),
      ),
    );
  }
});

// ---------------------------------------------------------------------------
// #918: the JS -> native contract. Each of these reproduces one half of what
// actually shipped in #912 and could not be seen by any gate.
// ---------------------------------------------------------------------------

test("a @tauri-apps/plugin-* dependency with no crate behind it fails", () => {
  const content = inputs(CONTENT);
  content.packageJson.dependencies["@tauri-apps/plugin-http"] = "^2.5.9";
  content.manifest = content.manifest.replaceAll(
    "\ntauri-plugin-http =",
    "\n# tauri-plugin-http =",
  );
  assert.ok(
    surfaceFailures(CONTENT, content).some((failure) =>
      failure.includes("tauri-plugin-http is not linked"),
    ),
  );
});

test("a linked plugin that is never initialized fails", () => {
  const content = inputs(CONTENT);
  content.entrypoint = content.entrypoint.replace(
    ".plugin(tauri_plugin_http::init())\n        ",
    "",
  );
  assert.ok(
    surfaceFailures(CONTENT, content).some((failure) =>
      failure.includes("linked but never initialized"),
    ),
  );
});

test("invoking a command the binary does not register fails", () => {
  const content = withSource(
    CONTENT,
    "fabricated.ts",
    'const x = await invoke<string>("oauth_callback_transport");\n',
  );
  assert.ok(
    surfaceFailures(CONTENT, content).some((failure) =>
      failure.includes('invokes "oauth_callback_transport"'),
    ),
  );
});

test("invoking a plugin command whose crate is absent fails", () => {
  const content = withSource(
    CONTENT,
    "fabricated.ts",
    'await invoke("plugin:zcash|sign_challenge", {});\n',
  );
  assert.ok(
    surfaceFailures(CONTENT, content).some((failure) =>
      failure.includes("does not link tauri-plugin-zcash"),
    ),
  );
});

test("a command name that IS registered passes, so the rule is not blanket", () => {
  const messaging = withSource(
    MESSAGING,
    "fabricated.ts",
    'await invoke("e2e2z_device_credential_keys");\n',
  );
  assert.deepEqual(surfaceFailures(MESSAGING, messaging), []);
});

test("the content surface must not even import the invoke function", () => {
  const content = withSource(
    CONTENT,
    "fabricated.ts",
    'import { invoke } from "@tauri-apps/api/core";\nexport default invoke;\n',
  );
  assert.ok(
    surfaceFailures(CONTENT, content).some((failure) =>
      failure.includes("imports @tauri-apps/api/core"),
    ),
  );
});

test("an invoke_handler on the content surface fails", () => {
  const content = inputs(CONTENT);
  content.entrypoint = content.entrypoint.replace(
    ".run(tauri::generate_context!())",
    ".invoke_handler(tauri::generate_handler![something])\n        .run(tauri::generate_context!())",
  );
  assert.ok(
    surfaceFailures(CONTENT, content).some((failure) =>
      failure.includes("must register no invoke_handler"),
    ),
  );
});

// ---------------------------------------------------------------------------
// #918's most serious defect: a private-use URI belonging to another app.
// The other two gaps fail closed and loudly; this one delivers a secret to the
// wrong process on any device carrying both apps.
// ---------------------------------------------------------------------------

test("a URI in another app's scheme fails", () => {
  for (const uri of [
    "cash.free2z.zuuli://oauth/callback",
    "cash.free2z.zuuli://checkout/return",
    "cash.free2z.e2e2z://bridge/return",
  ]) {
    const content = withSource(
      CONTENT,
      "fabricated.ts",
      `export const RETURN_URI = "${uri}";\n`,
    );
    assert.ok(
      surfaceFailures(CONTENT, content).some((failure) =>
        failure.includes("belongs to another app"),
      ),
      `${uri} must be refused in the content surface`,
    );
  }
});

test("this app's own scheme on an unregistered route fails", () => {
  const content = withSource(
    CONTENT,
    "fabricated.ts",
    'export const RETURN_URI = "cash.free2z.free2z://oauth/unregistered";\n',
  );
  assert.ok(
    surfaceFailures(CONTENT, content).some((failure) =>
      failure.includes("is not registered in"),
    ),
  );
});

test("removing a deep-link route breaks the constant that names it", () => {
  const content = inputs(CONTENT);
  content.tauriConfig.plugins["deep-link"].mobile =
    content.tauriConfig.plugins["deep-link"].mobile.filter(
      (entry) => entry.host !== "checkout",
    );
  assert.ok(
    surfaceFailures(CONTENT, content).some(
      (failure) =>
        failure.includes("cash.free2z.free2z://checkout/return") &&
        failure.includes("is not registered in"),
    ),
  );
});

test("an empty production source population is a blindness failure, not a pass", () => {
  const content = inputs(CONTENT);
  content.sources = new Map();
  assert.ok(
    surfaceFailures(CONTENT, content).some((failure) =>
      failure.includes("the JS -> native contract check has gone blind"),
    ),
  );
});
