#!/usr/bin/env node

// Assert that the Apple signing certificate we are about to sign with is one
// the provisioning profile actually authorizes -- before `xcodebuild archive`
// or `xcodebuild -exportArchive`, not twenty minutes into a macOS runner.
//
// WHY THIS EXISTS (issue #960)
//
// A provisioning profile authorizes a specific set of certificates by embedding
// their DER bytes in `DeveloperCertificates`. If the imported `.p12` holds a
// different identity, every step up to export succeeds: the keychain import
// works, `security find-identity` lists a perfectly valid Apple Distribution
// identity, the archive builds. The failure arrives only at
// `xcodebuild -exportArchive`, near the end of the job, worded in a way that
// never names the mismatch.
//
// Two Apple Distribution certificates exist for team F9AV5HKF6N:
//
//   5F:06:...:B5:B7  expires 2027-08-08  <- the only one any profile embeds
//   D1:78:...:E8:F9  expires 2027-04-16  <- no profile authorizes it
//
// and the trap is that `security find-identity -v -p codesigning` on the dev
// machine returns only the second, because the first certificate's private key
// is in no keychain -- it lives solely inside a .p12. Deriving the identity
// from the keychain therefore yields a key no profile accepts. That wrong
// certificate was in fact installed into the `e2e2z-app-stores` environment:
// all four secrets present, correctly named, and wrong in content. A presence
// check cannot see that class of bug; only comparing the material can.
//
// Note also that the two expiry dates differ. The profile runs to 2027-08-08
// and the certificate dies first, on 2027-04-16 -- and the certificate's date
// is not the one anyone watches. So both are reported, always, on success as
// well as on failure.
//
// WHAT IT ASSERTS
//
//   1. profile-authorizes-certificate  the leaf certificate's SHA-1 appears in
//                                      the profile's DeveloperCertificates
//   2. certificate-key-pair            the .p12's certificate and private key
//                                      are the same key pair (catches a
//                                      truncated or mis-assembled export)
//   3. keychain-identity               the identity the keychain will sign with
//                                      is the leaf we just checked (optional)
//   4. application-identifier          the profile's entitlement equals
//                                      <team>.<bundle id>
//   5. team-identifier                 the profile's TeamIdentifier equals the
//                                      expected team
//   6. profile-validity                now is inside the profile's window
//   7. certificate-validity            now is inside the certificate's window
//
// 6 and 7 also warn when either date is inside --warn-days (default 30).
//
// PORTABILITY, AND WHY IT IS NOT A SHELL SCRIPT
//
// `security` and `PlistBuddy`/`plutil` are macOS-only, so a check built on them
// can only be tested where the credentials are -- which is to say, never. The
// parsing and comparison here is pure Node: the plist parser below is
// hand-written, certificates are read with node:crypto's X509Certificate, and
// fingerprints are the SHA-1 of the DER, which is exactly what `openssl x509
// -fingerprint -sha1` prints. `security cms -D` is used to unwrap a CMS-signed
// profile when it is available, and `openssl smime -verify` when it is not, so
// the whole path -- including a real .mobileprovision and a real .p12 -- runs
// on Linux CI with no Apple credentials at all. See --self-test and
// scripts/verify-signing-identity.node-test.mjs.
//
// The release workflows cannot check the repository out in a signing job (the
// credential boundary forbids it), so they carry this file into the job inside
// the attested unsigned artifact, the same way asc-testflight.mjs reaches the
// upload job.

import { spawnSync } from "node:child_process";
import { X509Certificate, createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const MINIMUM_NODE_MAJOR = 20;
const DEFAULT_WARN_DAYS = 30;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// plist
// ---------------------------------------------------------------------------

const ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, body) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    }
    const replacement = ENTITIES.get(body);
    if (replacement === undefined) throw new Error(`unsupported XML entity &${body};`);
    return replacement;
  });
}

// A deliberately small XML-plist reader. It accepts exactly the element set
// Apple emits in a decoded provisioning profile and throws on anything else,
// because silently ignoring an element it does not understand is how a parser
// starts reporting a profile that is not the profile on disk.
export function parsePlistXml(source) {
  const src = String(source);
  let index = 0;

  const fail = (message) => {
    throw new Error(`plist parse error at offset ${index}: ${message}`);
  };

  const skipIgnorable = () => {
    for (;;) {
      while (index < src.length && /\s/.test(src[index])) index += 1;
      if (src.startsWith("<?", index)) {
        const end = src.indexOf("?>", index);
        if (end < 0) fail("unterminated processing instruction");
        index = end + 2;
        continue;
      }
      if (src.startsWith("<!--", index)) {
        const end = src.indexOf("-->", index);
        if (end < 0) fail("unterminated comment");
        index = end + 3;
        continue;
      }
      if (src.startsWith("<!", index)) {
        const end = src.indexOf(">", index);
        if (end < 0) fail("unterminated declaration");
        index = end + 1;
        continue;
      }
      return;
    }
  };

  const readTag = () => {
    skipIgnorable();
    if (src[index] !== "<") fail("expected an element");
    const end = src.indexOf(">", index);
    if (end < 0) fail("unterminated element");
    let raw = src.slice(index + 1, end);
    index = end + 1;
    const closing = raw.startsWith("/");
    if (closing) raw = raw.slice(1);
    const selfClosing = raw.endsWith("/");
    if (selfClosing) raw = raw.slice(0, -1);
    const name = raw.trim().split(/\s+/)[0];
    if (!name) fail("empty element name");
    return { name, closing, selfClosing };
  };

  const readTextUntilClose = (name) => {
    const close = `</${name}>`;
    const end = src.indexOf(close, index);
    if (end < 0) fail(`unterminated <${name}>`);
    const raw = src.slice(index, end);
    index = end + close.length;
    return decodeEntities(raw);
  };

  const parseValue = (tag) => {
    if (tag.closing) fail(`unexpected </${tag.name}>`);
    switch (tag.name) {
      case "dict": {
        const value = new Map();
        if (tag.selfClosing) return value;
        for (;;) {
          const next = readTag();
          if (next.closing && next.name === "dict") return value;
          if (next.name !== "key" || next.closing || next.selfClosing) fail("expected <key>");
          const key = readTextUntilClose("key");
          value.set(key, parseValue(readTag()));
        }
      }
      case "array": {
        const value = [];
        if (tag.selfClosing) return value;
        for (;;) {
          const next = readTag();
          if (next.closing && next.name === "array") return value;
          value.push(parseValue(next));
        }
      }
      case "string":
        return tag.selfClosing ? "" : readTextUntilClose("string");
      case "data": {
        if (tag.selfClosing) return Buffer.alloc(0);
        const encoded = readTextUntilClose("data").replace(/\s+/g, "");
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) fail("<data> is not base64");
        return Buffer.from(encoded, "base64");
      }
      case "date": {
        const text = tag.selfClosing ? "" : readTextUntilClose("date");
        const value = new Date(text);
        if (Number.isNaN(value.getTime())) fail(`invalid <date> ${text}`);
        return value;
      }
      case "integer":
      case "real": {
        const text = tag.selfClosing ? "" : readTextUntilClose(tag.name);
        const value = Number(text.trim());
        if (!Number.isFinite(value)) fail(`invalid <${tag.name}> ${text}`);
        return value;
      }
      case "true":
      case "false": {
        if (!tag.selfClosing) readTextUntilClose(tag.name);
        return tag.name === "true";
      }
      default:
        return fail(`unsupported plist element <${tag.name}>`);
    }
  };

  skipIgnorable();
  let tag = readTag();
  if (tag.name === "plist" && !tag.closing) tag = readTag();
  return parseValue(tag);
}

// ---------------------------------------------------------------------------
// certificates
// ---------------------------------------------------------------------------

export function certificateFingerprintSha1(der) {
  const digest = createHash("sha1").update(der).digest("hex").toUpperCase();
  return digest.replace(/(.{2})(?=.)/g, "$1:");
}

export function normalizeFingerprint(value) {
  return String(value).trim().toUpperCase().replace(/[^0-9A-F]/g, "");
}

function commonName(certificate) {
  const subject = String(certificate.subject ?? "");
  const match = subject.split("\n").find((line) => line.startsWith("CN="));
  return match ? match.slice(3) : subject.replace(/\n/g, ", ");
}

function publicKeyDigest(keyObject) {
  return createHash("sha256")
    .update(keyObject.export({ type: "spki", format: "der" }))
    .digest("hex");
}

export function describeCertificate(der) {
  const certificate = new X509Certificate(der);
  const notBefore = certificate.validFromDate ?? new Date(certificate.validFrom);
  const notAfter = certificate.validToDate ?? new Date(certificate.validTo);
  if (Number.isNaN(notBefore.getTime()) || Number.isNaN(notAfter.getTime())) {
    throw new Error("certificate carries an unreadable validity window");
  }
  return {
    fingerprint: certificateFingerprintSha1(certificate.raw),
    commonName: commonName(certificate),
    notBefore,
    notAfter,
    publicKeySha256: publicKeyDigest(certificate.publicKey),
    der: certificate.raw,
  };
}

// PEM bundles come back from openssl with human-readable preamble between the
// blocks; take only the blocks.
export function splitPemCertificates(pem) {
  const blocks = String(pem).match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
  );
  return blocks ?? [];
}

// ---------------------------------------------------------------------------
// external tools
// ---------------------------------------------------------------------------

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.error) {
    return { ok: false, stdout: Buffer.alloc(0), stderr: String(result.error.message) };
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: (result.stderr ?? Buffer.alloc(0)).toString("utf8"),
  };
}

// A .mobileprovision / .provisionprofile is a CMS SignedData envelope around
// the plist. `security cms -D` is the Apple way and is used when present;
// `openssl smime -verify -noverify` reads the same envelope everywhere else,
// which is what makes this testable on Linux.
export function decodeProvisioningProfile(bytes, { openssl = "openssl", security = "/usr/bin/security" } = {}) {
  const head = bytes.subarray(0, 8).toString("latin1");
  if (head.startsWith("<?xml") || head.startsWith("<plist")) {
    return { plist: bytes.toString("utf8"), decoder: "already-decoded" };
  }
  if (head.startsWith("bplist")) {
    throw new Error(
      "the provisioning profile decoded to a binary plist; convert it with `plutil -convert xml1` first",
    );
  }

  const scratch = mkdtempSync(join(tmpdir(), "verify-signing-identity-cms."));
  try {
    const profilePath = join(scratch, "profile.bin");
    writeFileSync(profilePath, bytes, { mode: 0o600 });
    const attempts = [];
    if (existsSync(security)) {
      attempts.push({ decoder: "security cms -D", command: security, args: ["cms", "-D", "-i", profilePath] });
    }
    attempts.push({
      decoder: "openssl smime -verify -noverify",
      command: openssl,
      args: ["smime", "-verify", "-noverify", "-inform", "DER", "-in", profilePath],
    });
    attempts.push({
      decoder: "openssl cms -verify -no_verify",
      command: openssl,
      args: ["cms", "-verify", "-no_verify", "-inform", "DER", "-in", profilePath],
    });

    const errors = [];
    for (const attempt of attempts) {
      const result = run(attempt.command, attempt.args);
      if (result.ok && result.stdout.length > 0) {
        return { plist: result.stdout.toString("utf8"), decoder: attempt.decoder };
      }
      errors.push(`${attempt.decoder}: ${result.stderr.trim() || "produced no output"}`);
    }
    throw new Error(`could not decode the provisioning profile\n  ${errors.join("\n  ")}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// openssl 3 refuses the RC2-40 encryption Keychain Access used for years
// unless -legacy is passed; LibreSSL (what /usr/bin/openssl is on macOS) has no
// such flag and reads those archives directly. Try plain first, then -legacy,
// and report both failures rather than one.
export function extractPkcs12(p12Path, passwordEnvName, { openssl = "openssl", env = process.env } = {}) {
  if (!(passwordEnvName in env)) {
    throw new Error(`${passwordEnvName} is not set, so the .p12 cannot be opened`);
  }
  // Nothing is written to disk here: the private key comes back on openssl's
  // stdout and stays in memory.
  {
    const attempts = [[], ["-legacy"]];
    const errors = [];
    let certificatesPem = null;
    let keyPem = null;
    for (const extra of attempts) {
      const certificates = run(
        openssl,
        ["pkcs12", "-in", p12Path, "-passin", `env:${passwordEnvName}`, "-nokeys", "-clcerts", ...extra],
        { env },
      );
      const key = run(
        openssl,
        ["pkcs12", "-in", p12Path, "-passin", `env:${passwordEnvName}`, "-nocerts", "-nodes", ...extra],
        { env },
      );
      if (certificates.ok && key.ok) {
        certificatesPem = certificates.stdout.toString("utf8");
        keyPem = key.stdout.toString("utf8");
        break;
      }
      const label = extra.length === 0 ? "openssl pkcs12" : "openssl pkcs12 -legacy";
      errors.push(`${label}: ${(certificates.ok ? key.stderr : certificates.stderr).trim() || "failed"}`);
    }
    if (certificatesPem === null || keyPem === null) {
      throw new Error(
        `could not read the signing archive with openssl (wrong password, or an encoding openssl will not open)\n  ${errors.join("\n  ")}`,
      );
    }

    let certificates = splitPemCertificates(certificatesPem);
    if (certificates.length === 0) {
      const all = run(openssl, ["pkcs12", "-in", p12Path, "-passin", `env:${passwordEnvName}`, "-nokeys"], { env });
      certificates = all.ok ? splitPemCertificates(all.stdout.toString("utf8")) : [];
    }
    if (certificates.length === 0) {
      throw new Error("the signing archive contains no certificate");
    }

    const privateKey = createPrivateKey(keyPem);
    const privateKeyPublicSha256 = publicKeyDigest(createPublicKey(privateKey));
    const described = certificates.map((pem) => describeCertificate(Buffer.from(pem, "utf8")));
    const matching = described.filter((entry) => entry.publicKeySha256 === privateKeyPublicSha256);
    const leaf = matching.length === 1 ? matching[0] : described[0];
    return {
      leaf,
      certificateCount: described.length,
      privateKeyPublicSha256,
      privateKeyType: privateKey.asymmetricKeyType ?? "unknown",
    };
  }
}

// ---------------------------------------------------------------------------
// profile model
// ---------------------------------------------------------------------------

export function readProfile(plistXml) {
  const root = parsePlistXml(plistXml);
  if (!(root instanceof Map)) throw new Error("the provisioning profile is not a plist dictionary");
  const entitlements = root.get("Entitlements");
  const developerCertificates = root.get("DeveloperCertificates") ?? [];
  if (!Array.isArray(developerCertificates)) {
    throw new Error("the profile's DeveloperCertificates is not an array");
  }
  const certificates = developerCertificates.map((der) => {
    if (!Buffer.isBuffer(der)) throw new Error("a DeveloperCertificates entry is not <data>");
    return describeCertificate(der);
  });
  const applicationIdentifier = entitlements instanceof Map
    ? entitlements.get("application-identifier") ?? entitlements.get("com.apple.application-identifier")
    : undefined;
  const teamIdentifiers = root.get("TeamIdentifier");
  return {
    name: root.get("Name"),
    uuid: root.get("UUID"),
    teamIdentifiers: Array.isArray(teamIdentifiers) ? teamIdentifiers : [],
    applicationIdentifier,
    creationDate: root.get("CreationDate"),
    expirationDate: root.get("ExpirationDate"),
    certificates,
  };
}

// ---------------------------------------------------------------------------
// evaluation
// ---------------------------------------------------------------------------

const iso = (date) => (date instanceof Date ? date.toISOString().replace(/\.\d{3}Z$/, "Z") : "unknown");
const daysUntil = (date, now) =>
  date instanceof Date ? Math.floor((date.getTime() - now.getTime()) / DAY_MS) : Number.NaN;

// Pure: everything above turns bytes into these two plain objects, and this
// decides. That split is what lets the negative control run anywhere.
export function evaluateSigningIdentity({
  profile,
  leaf,
  expected = {},
  now = new Date(),
  warnDays = DEFAULT_WARN_DAYS,
}) {
  const assertions = [];
  const add = (name, status, detail) => assertions.push({ name, status, detail });

  const leafFingerprint = normalizeFingerprint(leaf.fingerprint);
  const authorized = profile.certificates.map((certificate) => ({
    ...certificate,
    normalized: normalizeFingerprint(certificate.fingerprint),
  }));
  const match = authorized.find((certificate) => certificate.normalized === leafFingerprint);

  if (authorized.length === 0) {
    add(
      "profile-authorizes-certificate",
      "fail",
      "the provisioning profile embeds no DeveloperCertificates at all, so it authorizes nothing",
    );
  } else if (match) {
    add(
      "profile-authorizes-certificate",
      "pass",
      `the profile authorizes ${leaf.fingerprint} (${leaf.commonName})`,
    );
  } else {
    add(
      "profile-authorizes-certificate",
      "fail",
      [
        `the imported certificate ${leaf.fingerprint} (${leaf.commonName}, expires ${iso(leaf.notAfter)})`,
        `is not among the ${authorized.length} certificate(s) this profile authorizes:`,
        ...authorized.map(
          (certificate) =>
            `  ${certificate.fingerprint} (${certificate.commonName}, expires ${iso(certificate.notAfter)})`,
        ),
        "signing would still produce an archive and fail only at `xcodebuild -exportArchive`.",
        "the .p12 in the environment holds the wrong identity, or the profile is not the one issued for it.",
      ].join("\n"),
    );
  }

  if (expected.privateKeyPublicSha256 !== undefined) {
    if (expected.privateKeyPublicSha256 === leaf.publicKeySha256) {
      add(
        "certificate-key-pair",
        "pass",
        `the archive's certificate and private key are one ${expected.privateKeyType ?? "key"} pair (SPKI ${leaf.publicKeySha256.slice(0, 16)}…)`,
      );
    } else {
      add(
        "certificate-key-pair",
        "fail",
        [
          "the .p12's certificate and private key are different key pairs -- the export is truncated or mis-assembled.",
          `  certificate public key SPKI sha256 ${leaf.publicKeySha256}`,
          `  private key public key SPKI sha256 ${expected.privateKeyPublicSha256}`,
        ].join("\n"),
      );
    }
  }

  if (expected.keychainIdentitySha1 !== undefined) {
    const keychain = normalizeFingerprint(expected.keychainIdentitySha1);
    if (keychain.length !== 40) {
      add("keychain-identity", "fail", `"${expected.keychainIdentitySha1}" is not a SHA-1 identity digest`);
    } else if (keychain === leafFingerprint) {
      add("keychain-identity", "pass", `the keychain will sign with ${leaf.fingerprint}`);
    } else {
      add(
        "keychain-identity",
        "fail",
        [
          "the identity the keychain would sign with is not the certificate checked above.",
          `  keychain identity ${keychain.replace(/(.{2})(?=.)/g, "$1:")}`,
          `  archive leaf      ${leaf.fingerprint}`,
        ].join("\n"),
      );
    }
  }

  if (expected.bundleId !== undefined) {
    const team = expected.teamId ?? profile.teamIdentifiers[0];
    const wanted = `${team}.${expected.bundleId}`;
    if (profile.applicationIdentifier === wanted) {
      add("application-identifier", "pass", `the profile is issued for ${wanted}`);
    } else {
      add(
        "application-identifier",
        "fail",
        `the profile is issued for ${profile.applicationIdentifier ?? "no application-identifier"}, not ${wanted}`,
      );
    }
  }

  if (expected.teamId !== undefined) {
    if (profile.teamIdentifiers.length === 1 && profile.teamIdentifiers[0] === expected.teamId) {
      add("team-identifier", "pass", `the profile belongs to team ${expected.teamId}`);
    } else {
      add(
        "team-identifier",
        "fail",
        `expected exactly team ${expected.teamId}; the profile carries [${profile.teamIdentifiers.join(", ")}]`,
      );
    }
  }

  if (expected.profileUuid !== undefined) {
    add(
      "profile-uuid",
      profile.uuid === expected.profileUuid ? "pass" : "fail",
      `profile UUID ${profile.uuid ?? "absent"}${profile.uuid === expected.profileUuid ? "" : ` does not equal the expected ${expected.profileUuid}`}`,
    );
  }
  if (expected.profileName !== undefined) {
    add(
      "profile-name",
      profile.name === expected.profileName ? "pass" : "fail",
      `profile name ${JSON.stringify(profile.name ?? null)}${profile.name === expected.profileName ? "" : ` does not equal the expected ${JSON.stringify(expected.profileName)}`}`,
    );
  }

  const profileDays = daysUntil(profile.expirationDate, now);
  if (!(profile.expirationDate instanceof Date)) {
    add("profile-validity", "fail", "the profile carries no readable ExpirationDate");
  } else if (profile.creationDate instanceof Date && profile.creationDate.getTime() > now.getTime()) {
    add("profile-validity", "fail", `the profile is not valid until ${iso(profile.creationDate)}`);
  } else if (profileDays < 0) {
    add("profile-validity", "fail", `the provisioning profile expired on ${iso(profile.expirationDate)}`);
  } else if (profileDays <= warnDays) {
    add(
      "profile-validity",
      "warn",
      `the provisioning profile expires on ${iso(profile.expirationDate)} -- ${profileDays} day(s) from now`,
    );
  } else {
    add("profile-validity", "pass", `the profile is valid until ${iso(profile.expirationDate)} (${profileDays} days)`);
  }

  const certificateDays = daysUntil(leaf.notAfter, now);
  const alsoProfile = profile.expirationDate instanceof Date
    ? ` (the profile runs to ${iso(profile.expirationDate)}, so the certificate is what expires first)`
    : "";
  if (leaf.notBefore instanceof Date && leaf.notBefore.getTime() > now.getTime()) {
    add("certificate-validity", "fail", `the signing certificate is not valid until ${iso(leaf.notBefore)}`);
  } else if (certificateDays < 0) {
    add(
      "certificate-validity",
      "fail",
      `the signing certificate expired on ${iso(leaf.notAfter)}${alsoProfile}`,
    );
  } else if (certificateDays <= warnDays) {
    add(
      "certificate-validity",
      "warn",
      `the signing certificate expires on ${iso(leaf.notAfter)} -- ${certificateDays} day(s) from now${alsoProfile}`,
    );
  } else {
    add(
      "certificate-validity",
      "pass",
      `the certificate is valid until ${iso(leaf.notAfter)} (${certificateDays} days)`,
    );
  }

  const failures = assertions.filter((assertion) => assertion.status === "fail");
  const warnings = assertions.filter((assertion) => assertion.status === "warn");
  return { ok: failures.length === 0, assertions, failures, warnings };
}

export function renderReport({ profile, leaf, verdict, now, context = {} }) {
  const lines = [];
  lines.push("Apple signing preflight");
  if (context.label) lines.push(`  target                ${context.label}`);
  if (context.decoder) lines.push(`  profile decoded by    ${context.decoder}`);
  lines.push(`  evaluated at          ${iso(now)}`);
  lines.push("");
  lines.push("  imported certificate");
  lines.push(`    sha-1               ${leaf.fingerprint}`);
  lines.push(`    subject             ${leaf.commonName}`);
  lines.push(`    not before          ${iso(leaf.notBefore)}`);
  lines.push(`    not after           ${iso(leaf.notAfter)}  (${daysUntil(leaf.notAfter, now)} days)`);
  lines.push("");
  lines.push("  provisioning profile");
  lines.push(`    name                ${profile.name ?? "(none)"}`);
  lines.push(`    uuid                ${profile.uuid ?? "(none)"}`);
  lines.push(`    team                ${profile.teamIdentifiers.join(", ") || "(none)"}`);
  lines.push(`    app identifier      ${profile.applicationIdentifier ?? "(none)"}`);
  lines.push(
    `    expires             ${iso(profile.expirationDate)}  (${daysUntil(profile.expirationDate, now)} days)`,
  );
  lines.push(`    authorizes          ${profile.certificates.length} certificate(s)`);
  for (const certificate of profile.certificates) {
    const marker = normalizeFingerprint(certificate.fingerprint) === normalizeFingerprint(leaf.fingerprint)
      ? "<= imported"
      : "";
    lines.push(
      `      ${certificate.fingerprint}  ${iso(certificate.notAfter)}  ${certificate.commonName} ${marker}`.trimEnd(),
    );
  }
  lines.push("");
  for (const assertion of verdict.assertions) {
    const badge = assertion.status === "pass" ? "PASS" : assertion.status === "warn" ? "WARN" : "FAIL";
    const [first, ...rest] = assertion.detail.split("\n");
    lines.push(`  ${badge} ${assertion.name}: ${first}`);
    for (const line of rest) lines.push(`       ${line}`);
  }
  if (!verdict.ok) {
    lines.push("");
    lines.push(
      `  FAILED: ${verdict.failures.map((failure) => failure.name).join(", ")} -- refusing to sign.`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const OPTIONS = {
  profile: { type: "string" },
  p12: { type: "string" },
  "p12-password-env": { type: "string" },
  certificate: { type: "string" },
  "keychain-identity-sha1": { type: "string" },
  "bundle-id": { type: "string" },
  "team-id": { type: "string" },
  "expect-profile-uuid": { type: "string" },
  "expect-profile-name": { type: "string" },
  "warn-days": { type: "string" },
  now: { type: "string" },
  label: { type: "string" },
  openssl: { type: "string" },
  "allow-missing-inputs": { type: "boolean" },
  "self-test": { type: "boolean" },
  help: { type: "boolean" },
};

const USAGE = `usage: verify-signing-identity.mjs --profile <file> (--p12 <file> --p12-password-env <NAME> | --certificate <file>) [options]

  --profile <file>                 .mobileprovision/.provisionprofile, or an already decoded plist
  --p12 <file>                     the signing archive that was imported into the keychain
  --p12-password-env <NAME>        environment variable holding the .p12 password (never an argument)
  --certificate <file>             leaf certificate (PEM or DER), instead of --p12
  --keychain-identity-sha1 <hex>   the identity 'security find-identity' resolved, to bind what will sign
  --bundle-id <id>                 e.g. cash.free2z.zuuli
  --team-id <id>                   e.g. F9AV5HKF6N (defaults to $APPLE_TEAM_ID)
  --expect-profile-uuid <uuid>     optional exact profile UUID
  --expect-profile-name <name>     optional exact profile name
  --warn-days <n>                  warn when either expiry is within n days (default ${DEFAULT_WARN_DAYS})
  --now <iso>                      evaluate against this instant instead of the clock
  --label <text>                   a name for this signing path, printed in the report
  --allow-missing-inputs           print a SKIP line and exit 0 when no Apple inputs are present
  --self-test                      build throwaway certificates and prove the check still rejects a mismatch
`;

function readInputs(values, env) {
  const profilePath = values.profile;
  const p12Path = values.p12;
  const certificatePath = values.certificate;
  const present = [profilePath, p12Path, certificatePath].filter(
    (candidate) => candidate !== undefined && candidate !== "" && existsSync(candidate),
  );
  if (present.length === 0) {
    if (values["allow-missing-inputs"]) return { skip: true };
    throw new Error(
      "no Apple signing inputs were given. Pass --profile with --p12 or --certificate, or --allow-missing-inputs for a path that legitimately has none.",
    );
  }
  if (!profilePath || !existsSync(profilePath)) {
    throw new Error("a provisioning profile is required: pass --profile");
  }

  const { plist, decoder } = decodeProvisioningProfile(readFileSync(profilePath), {
    openssl: values.openssl ?? "openssl",
  });
  const profile = readProfile(plist);

  let leaf;
  let expectedKeyPair = {};
  if (p12Path && existsSync(p12Path)) {
    const passwordEnv = values["p12-password-env"];
    if (!passwordEnv) throw new Error("--p12 requires --p12-password-env");
    const extracted = extractPkcs12(p12Path, passwordEnv, { openssl: values.openssl ?? "openssl", env });
    leaf = extracted.leaf;
    expectedKeyPair = {
      privateKeyPublicSha256: extracted.privateKeyPublicSha256,
      privateKeyType: extracted.privateKeyType,
    };
  } else if (certificatePath && existsSync(certificatePath)) {
    leaf = describeCertificate(readFileSync(certificatePath));
  } else {
    throw new Error("a signing certificate is required: pass --p12 or --certificate");
  }

  return { skip: false, profile, leaf, decoder, expectedKeyPair };
}

export function runCli(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false }));
  } catch (error) {
    stderr.write(`verify-signing-identity: ${error.message}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    stdout.write(USAGE);
    return 0;
  }

  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (Number.isFinite(major) && major < MINIMUM_NODE_MAJOR) {
    stderr.write(
      `verify-signing-identity: node ${MINIMUM_NODE_MAJOR}+ is required, this is ${process.versions.node}\n`,
    );
    return 2;
  }

  let inputs;
  try {
    inputs = readInputs(values, env);
  } catch (error) {
    stderr.write(`verify-signing-identity: ${error.message}\n`);
    return 1;
  }
  if (inputs.skip) {
    stdout.write(
      `verify-signing-identity: SKIP -- ${values.label ? `${values.label}: ` : ""}no Apple signing inputs on this path, nothing to verify\n`,
    );
    return 0;
  }

  const now = values.now ? new Date(values.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    stderr.write(`verify-signing-identity: --now ${values.now} is not a date\n`);
    return 2;
  }
  const warnDays = values["warn-days"] === undefined ? DEFAULT_WARN_DAYS : Number(values["warn-days"]);
  if (!Number.isFinite(warnDays) || warnDays < 0) {
    stderr.write(`verify-signing-identity: --warn-days ${values["warn-days"]} is not a day count\n`);
    return 2;
  }

  const teamId = values["team-id"] ?? env.APPLE_TEAM_ID;
  const verdict = evaluateSigningIdentity({
    profile: inputs.profile,
    leaf: inputs.leaf,
    now,
    warnDays,
    expected: {
      ...inputs.expectedKeyPair,
      keychainIdentitySha1: values["keychain-identity-sha1"],
      bundleId: values["bundle-id"],
      teamId,
      profileUuid: values["expect-profile-uuid"],
      profileName: values["expect-profile-name"],
    },
  });

  const report = renderReport({
    profile: inputs.profile,
    leaf: inputs.leaf,
    verdict,
    now,
    context: { label: values.label, decoder: inputs.decoder },
  });
  (verdict.ok ? stdout : stderr).write(`${report}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(env.GITHUB_STEP_SUMMARY, `\n\`\`\`\n${report}\n\`\`\`\n`);
    } catch {
      // A step summary is a convenience; never fail a release over it.
    }
  }
  return verdict.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// fixtures + self-test
// ---------------------------------------------------------------------------

function opensslOrThrow(openssl, args, options) {
  const result = run(openssl, args, options);
  if (!result.ok) {
    throw new Error(`openssl ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

// Throwaway self-signed material, so the negative control is a real
// certificate/profile pair rather than a hand-edited fixture. No Apple
// credential is involved and nothing here leaves the temporary directory.
export function buildFixtures(directory, { openssl = "openssl", teamId = "TEAMFIXTUR", bundleId = "cash.free2z.fixture" } = {}) {
  const identity = (name, days) => {
    const keyPath = join(directory, `${name}.key.pem`);
    const certPath = join(directory, `${name}.cert.pem`);
    opensslOrThrow(openssl, [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", String(days),
      "-subj", `/C=US/O=Fixture Inc/OU=${teamId}/CN=Apple Distribution: Fixture ${name}`,
    ]);
    const der = new X509Certificate(readFileSync(certPath)).raw;
    return { name, keyPath, certPath, der, fingerprint: certificateFingerprintSha1(der) };
  };

  const authorized = identity("A", 800);
  const impostor = identity("B", 800);

  const profileExpiry = new Date(Date.now() + 900 * DAY_MS);
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Name</key>",
    "\t<string>Fixture App Store CI</string>",
    "\t<key>UUID</key>",
    "\t<string>00000000-0000-4000-8000-000000000001</string>",
    "\t<key>TeamIdentifier</key>",
    `\t<array><string>${teamId}</string></array>`,
    "\t<key>DeveloperCertificates</key>",
    `\t<array><data>${authorized.der.toString("base64")}</data></array>`,
    "\t<key>Entitlements</key>",
    "\t<dict>",
    "\t\t<key>application-identifier</key>",
    `\t\t<string>${teamId}.${bundleId}</string>`,
    "\t</dict>",
    "\t<key>CreationDate</key>",
    `\t<date>${iso(new Date(Date.now() - DAY_MS))}</date>`,
    "\t<key>ExpirationDate</key>",
    `\t<date>${iso(profileExpiry)}</date>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
  const plistPath = join(directory, "profile.plist");
  writeFileSync(plistPath, plist);

  // A real CMS envelope, so the decode path is exercised rather than assumed.
  const profilePath = join(directory, "fixture.mobileprovision");
  opensslOrThrow(openssl, [
    "smime", "-sign", "-signer", authorized.certPath, "-inkey", authorized.keyPath,
    "-in", plistPath, "-outform", "DER", "-nodetach", "-noattr", "-binary", "-out", profilePath,
  ]);

  const password = "fixture-password";
  const archive = (holder) => {
    const p12Path = join(directory, `${holder.name}.p12`);
    opensslOrThrow(
      openssl,
      ["pkcs12", "-export", "-inkey", holder.keyPath, "-in", holder.certPath, "-passout", "env:FIXTURE_P12_PASSWORD", "-out", p12Path],
      { env: { ...process.env, FIXTURE_P12_PASSWORD: password } },
    );
    return p12Path;
  };

  return {
    teamId,
    bundleId,
    password,
    profilePath,
    plistPath,
    profileExpiry,
    authorized: { ...authorized, p12Path: archive(authorized) },
    impostor: { ...impostor, p12Path: archive(impostor) },
  };
}

class Recorder {
  constructor() {
    this.text = "";
  }
  write(chunk) {
    this.text += chunk;
    return true;
  }
}

// Every case here is also a node:test in scripts/verify-signing-identity.node-test.mjs.
// This entry point exists so the release job itself watches the check fail
// before it trusts the check's verdict on the real credentials.
export function selfTest({ log = (line) => process.stdout.write(`${line}\n`), openssl = "openssl" } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "verify-signing-identity-selftest."));
  const failures = [];
  const record = (name, ok, detail) => {
    log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` -- ${detail}` : ""}`);
    if (!ok) failures.push(name);
  };
  try {
    const fixtures = buildFixtures(directory, { openssl });
    const env = { ...process.env, FIXTURE_P12_PASSWORD: fixtures.password, GITHUB_STEP_SUMMARY: "" };
    const invoke = (extra) => {
      const stdout = new Recorder();
      const stderr = new Recorder();
      const code = runCli(
        [
          "--profile", fixtures.profilePath,
          "--p12-password-env", "FIXTURE_P12_PASSWORD",
          "--bundle-id", fixtures.bundleId,
          "--team-id", fixtures.teamId,
          ...extra,
        ],
        { env, stdout, stderr },
      );
      return { code, out: stdout.text + stderr.text };
    };

    const good = invoke(["--p12", fixtures.authorized.p12Path]);
    record("a matching certificate and profile pass", good.code === 0, good.code === 0 ? "" : good.out);
    record(
      "the passing report still names both expiry dates",
      good.out.includes(iso(fixtures.profileExpiry)) && good.out.includes("not after"),
    );

    // The negative control. This is the whole point of the file.
    const bad = invoke(["--p12", fixtures.impostor.p12Path]);
    record("a certificate no profile authorizes is rejected", bad.code === 1);
    record(
      "the rejection names both fingerprints",
      bad.out.includes(fixtures.impostor.fingerprint) && bad.out.includes(fixtures.authorized.fingerprint),
      bad.out.includes(fixtures.impostor.fingerprint) ? "" : "imported fingerprint missing from the message",
    );
    record(
      "the rejection names the failing assertion",
      bad.out.includes("FAILED: profile-authorizes-certificate"),
    );

    const wrongBundle = invoke(["--p12", fixtures.authorized.p12Path, "--bundle-id", "cash.free2z.other"]);
    record("a profile issued for another bundle id is rejected", wrongBundle.code === 1);

    const wrongTeam = invoke(["--p12", fixtures.authorized.p12Path, "--team-id", "WRONGTEAM0"]);
    record("a profile from another team is rejected", wrongTeam.code === 1);

    const wrongKeychain = invoke([
      "--p12", fixtures.authorized.p12Path,
      "--keychain-identity-sha1", fixtures.impostor.fingerprint,
    ]);
    record("a keychain identity other than the archive leaf is rejected", wrongKeychain.code === 1);

    // The certificate outlives nothing and the profile outlives it: the exact
    // shape of the real fleet, where the profile date is the one people watch.
    const leaf = describeCertificate(fixtures.authorized.der);
    const afterCertificate = new Date(leaf.notAfter.getTime() + DAY_MS);
    const expired = invoke(["--p12", fixtures.authorized.p12Path, "--now", afterCertificate.toISOString()]);
    record("an expired certificate under a live profile is rejected", expired.code === 1);
    record(
      "the expiry rejection reports both dates",
      expired.out.includes(iso(leaf.notAfter)) && expired.out.includes(iso(fixtures.profileExpiry)),
    );

    const soon = new Date(leaf.notAfter.getTime() - 5 * DAY_MS);
    const warned = invoke(["--p12", fixtures.authorized.p12Path, "--now", soon.toISOString()]);
    record("a certificate expiring within the warning window still passes", warned.code === 0);
    record("...and says so", warned.out.includes("WARN certificate-validity"));

    const missing = runCli(["--allow-missing-inputs", "--label", "android"], {
      env,
      stdout: new Recorder(),
      stderr: new Recorder(),
    });
    record("a path with no Apple inputs skips cleanly", missing === 0);
    const missingStrict = runCli([], { env, stdout: new Recorder(), stderr: new Recorder() });
    record("...but not silently: missing inputs without the flag fail", missingStrict === 1);
  } catch (error) {
    record("self-test fixtures", false, error.message);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    log(`verify-signing-identity --self-test FAILED: ${failures.join(", ")}`);
    return 1;
  }
  log("verify-signing-identity --self-test passed");
  return 0;
}

function main(argv) {
  if (argv.includes("--self-test")) {
    return selfTest();
  }
  return runCli(argv);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
