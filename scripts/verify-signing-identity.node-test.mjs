// The negative control for scripts/verify-signing-identity.mjs (issue #960).
//
// A signing preflight nobody has watched fail is a green check, not a check.
// So every case here builds real throwaway material with openssl -- two
// self-signed certificates, a CMS-wrapped provisioning profile embedding only
// the first, and a PKCS#12 archive for each -- and then proves the preflight
// accepts the pair that belongs together and rejects the pair that does not.
//
// This runs on Linux with no Apple credentials, by construction: the profile is
// decoded through `openssl smime -verify` when `security` is absent, and the
// decoder test below forces that path even on macOS. Nothing here skips: if
// openssl is missing the suite fails loudly rather than reporting success.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import {
  buildFixtures,
  certificateFingerprintSha1,
  decodeProvisioningProfile,
  describeCertificate,
  evaluateSigningIdentity,
  extractPkcs12,
  parsePlistXml,
  readProfile,
  runCli,
  selfTest,
} from "./verify-signing-identity.mjs";

const DAY_MS = 86_400_000;

class Recorder {
  constructor() {
    this.text = "";
  }
  write(chunk) {
    this.text += chunk;
    return true;
  }
}

let directory;
let fixtures;
let profile;

before(() => {
  const openssl = spawnSync("openssl", ["version"], { encoding: "utf8" });
  assert.equal(
    openssl.status,
    0,
    "openssl is required to build the throwaway signing material this suite is made of",
  );
  directory = mkdtempSync(join(tmpdir(), "verify-signing-identity-test."));
  fixtures = buildFixtures(directory);
  profile = readProfile(decodeProvisioningProfile(readFileSync(fixtures.profilePath)).plist);
});

after(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

const invoke = (extra) => {
  const stdout = new Recorder();
  const stderr = new Recorder();
  const code = runCli(
    [
      "--profile",
      fixtures.profilePath,
      "--p12-password-env",
      "FIXTURE_P12_PASSWORD",
      "--bundle-id",
      fixtures.bundleId,
      "--team-id",
      fixtures.teamId,
      ...extra,
    ],
    {
      env: { ...process.env, FIXTURE_P12_PASSWORD: fixtures.password, GITHUB_STEP_SUMMARY: "" },
      stdout,
      stderr,
    },
  );
  return { code, stdout: stdout.text, stderr: stderr.text, output: stdout.text + stderr.text };
};

describe("the profile/certificate pairing", () => {
  test("the certificate the profile embeds is accepted", () => {
    const result = invoke(["--p12", fixtures.authorized.p12Path]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /PASS profile-authorizes-certificate/);
  });

  // THE NEGATIVE CONTROL. Same team, same shape, valid certificate, correct
  // password, and no profile authorizes it: exactly the environment that was
  // populated correctly in form and wrong in content.
  test("a certificate no profile authorizes is rejected", () => {
    const result = invoke(["--p12", fixtures.impostor.p12Path]);
    assert.equal(result.code, 1, "the mismatched identity was accepted");
    assert.match(result.stderr, /FAIL profile-authorizes-certificate/);
    assert.match(result.stderr, /FAILED: profile-authorizes-certificate/);
  });

  test("the rejection names both fingerprints and both expiry dates", () => {
    const result = invoke(["--p12", fixtures.impostor.p12Path]);
    assert.ok(
      result.stderr.includes(fixtures.impostor.fingerprint),
      "the message must name the certificate that was imported",
    );
    assert.ok(
      result.stderr.includes(fixtures.authorized.fingerprint),
      "the message must name the certificate the profile authorizes",
    );
    const leaf = describeCertificate(fixtures.impostor.der);
    assert.ok(result.stderr.includes(leaf.notAfter.toISOString().replace(/\.\d{3}Z$/, "Z")));
    assert.ok(result.stderr.includes(fixtures.profileExpiry.toISOString().replace(/\.\d{3}Z$/, "Z")));
  });

  test("a profile that embeds no certificates authorizes nothing", () => {
    const verdict = evaluateSigningIdentity({
      profile: { ...profile, certificates: [] },
      leaf: describeCertificate(fixtures.authorized.der),
      expected: {},
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.failures[0].detail, /embeds no DeveloperCertificates/);
  });
});

describe("the archive's own coherence", () => {
  test("a well-formed archive yields one certificate that matches its key", () => {
    const extracted = extractPkcs12(fixtures.authorized.p12Path, "FIXTURE_P12_PASSWORD", {
      env: { ...process.env, FIXTURE_P12_PASSWORD: fixtures.password },
    });
    assert.equal(extracted.leaf.fingerprint, fixtures.authorized.fingerprint);
    assert.equal(extracted.leaf.publicKeySha256, extracted.privateKeyPublicSha256);
    assert.equal(
      invoke(["--p12", fixtures.authorized.p12Path]).stdout.includes("PASS certificate-key-pair"),
      true,
    );
  });

  test("a certificate and key from different pairs are rejected", () => {
    const verdict = evaluateSigningIdentity({
      profile,
      leaf: describeCertificate(fixtures.authorized.der),
      expected: {
        privateKeyPublicSha256: describeCertificate(fixtures.impostor.der).publicKeySha256,
        privateKeyType: "rsa",
      },
    });
    assert.equal(verdict.ok, false);
    assert.deepEqual(
      verdict.failures.map((failure) => failure.name),
      ["certificate-key-pair"],
    );
    assert.match(verdict.failures[0].detail, /truncated or mis-assembled/);
  });

  test("the wrong password fails loudly rather than reporting nothing to check", () => {
    assert.throws(
      () =>
        extractPkcs12(fixtures.authorized.p12Path, "FIXTURE_P12_PASSWORD", {
          env: { ...process.env, FIXTURE_P12_PASSWORD: "not-the-password" },
        }),
      /could not read the signing archive/,
    );
  });
});

describe("what the keychain will actually sign with", () => {
  test("the imported archive's leaf is accepted", () => {
    const result = invoke([
      "--p12",
      fixtures.authorized.p12Path,
      "--keychain-identity-sha1",
      fixtures.authorized.fingerprint.replace(/:/g, ""),
    ]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /PASS keychain-identity/);
  });

  // The trap in #960 in its purest form: `security find-identity` resolves an
  // identity that is not the one in the archive we checked.
  test("an identity other than the archive's leaf is rejected", () => {
    const result = invoke([
      "--p12",
      fixtures.authorized.p12Path,
      "--keychain-identity-sha1",
      fixtures.impostor.fingerprint.replace(/:/g, ""),
    ]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /FAIL keychain-identity/);
  });
});

describe("identity of the app being signed", () => {
  test("a profile issued for another bundle id is rejected", () => {
    const result = invoke(["--p12", fixtures.authorized.p12Path, "--bundle-id", "cash.free2z.other"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /FAIL application-identifier/);
  });

  test("a profile from another team is rejected", () => {
    const result = invoke(["--p12", fixtures.authorized.p12Path, "--team-id", "OTHERTEAM1"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /FAIL team-identifier/);
  });

  test("APPLE_TEAM_ID stands in for --team-id and is held to the same rule", () => {
    const stdout = new Recorder();
    const stderr = new Recorder();
    const code = runCli(
      [
        "--profile",
        fixtures.profilePath,
        "--p12",
        fixtures.authorized.p12Path,
        "--p12-password-env",
        "FIXTURE_P12_PASSWORD",
        "--bundle-id",
        fixtures.bundleId,
      ],
      {
        env: {
          ...process.env,
          FIXTURE_P12_PASSWORD: fixtures.password,
          APPLE_TEAM_ID: "OTHERTEAM1",
          GITHUB_STEP_SUMMARY: "",
        },
        stdout,
        stderr,
      },
    );
    assert.equal(code, 1);
    assert.match(stderr.text, /FAIL team-identifier/);
  });

  test("an unexpected profile uuid or name is rejected", () => {
    assert.equal(invoke(["--p12", fixtures.authorized.p12Path, "--expect-profile-uuid", "nope"]).code, 1);
    assert.equal(invoke(["--p12", fixtures.authorized.p12Path, "--expect-profile-name", "nope"]).code, 1);
    assert.equal(
      invoke([
        "--p12",
        fixtures.authorized.p12Path,
        "--expect-profile-uuid",
        profile.uuid,
        "--expect-profile-name",
        profile.name,
      ]).code,
      0,
    );
  });

  test("the macOS spelling of the entitlement is read too", () => {
    const macos = readProfile(
      readFileSync(fixtures.plistPath, "utf8").replace(
        "<key>application-identifier</key>",
        "<key>com.apple.application-identifier</key>",
      ),
    );
    assert.equal(macos.applicationIdentifier, `${fixtures.teamId}.${fixtures.bundleId}`);
  });
});

describe("the two expiry dates, which are not the same date", () => {
  const leaf = () => describeCertificate(fixtures.authorized.der);

  test("a live pair passes and reports both dates", () => {
    const result = invoke(["--p12", fixtures.authorized.p12Path]);
    assert.equal(result.code, 0, result.output);
    assert.ok(result.stdout.includes(leaf().notAfter.toISOString().replace(/\.\d{3}Z$/, "Z")));
    assert.ok(result.stdout.includes(fixtures.profileExpiry.toISOString().replace(/\.\d{3}Z$/, "Z")));
  });

  // The fixture mirrors the real fleet: the profile outlives the certificate,
  // so the date on the calendar is not the date that ends the release.
  test("the certificate expires before the profile does", () => {
    assert.ok(leaf().notAfter.getTime() < fixtures.profileExpiry.getTime());
  });

  test("an expired certificate under a still-valid profile is rejected", () => {
    const result = invoke([
      "--p12",
      fixtures.authorized.p12Path,
      "--now",
      new Date(leaf().notAfter.getTime() + DAY_MS).toISOString(),
    ]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /FAIL certificate-validity/);
    assert.match(result.stderr, /the certificate is what expires first/);
    assert.match(result.stderr, /PASS profile-validity/);
  });

  test("an expired profile under a still-valid certificate is rejected", () => {
    const result = invoke([
      "--p12",
      fixtures.authorized.p12Path,
      "--now",
      new Date(fixtures.profileExpiry.getTime() + DAY_MS).toISOString(),
    ]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /FAIL profile-validity/);
  });

  test("a certificate not yet valid is rejected", () => {
    const result = invoke([
      "--p12",
      fixtures.authorized.p12Path,
      "--now",
      new Date(leaf().notBefore.getTime() - DAY_MS).toISOString(),
    ]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /FAIL certificate-validity/);
  });

  test("an expiry inside the warning window warns without failing the release", () => {
    const result = invoke([
      "--p12",
      fixtures.authorized.p12Path,
      "--now",
      new Date(leaf().notAfter.getTime() - 5 * DAY_MS).toISOString(),
    ]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /WARN certificate-validity/);
    assert.match(result.stdout, /5 day\(s\) from now/);
  });

  test("--warn-days sets the window", () => {
    const now = new Date(leaf().notAfter.getTime() - 45 * DAY_MS).toISOString();
    assert.match(invoke(["--p12", fixtures.authorized.p12Path, "--now", now]).stdout, /PASS certificate-validity/);
    assert.match(
      invoke(["--p12", fixtures.authorized.p12Path, "--now", now, "--warn-days", "60"]).stdout,
      /WARN certificate-validity/,
    );
  });
});

describe("paths that carry no Apple inputs", () => {
  test("skipping is explicit, opt-in, and logged", () => {
    const stdout = new Recorder();
    const code = runCli(["--allow-missing-inputs", "--label", "android"], {
      env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
      stdout,
      stderr: new Recorder(),
    });
    assert.equal(code, 0);
    assert.match(stdout.text, /SKIP -- android: no Apple signing inputs/);
  });

  test("missing inputs without the flag are a failure, not a skip", () => {
    const stderr = new Recorder();
    const code = runCli([], { env: { ...process.env }, stdout: new Recorder(), stderr });
    assert.equal(code, 1);
    assert.match(stderr.text, /no Apple signing inputs were given/);
  });

  test("a certificate without a profile is a failure", () => {
    const stderr = new Recorder();
    const code = runCli(["--certificate", fixtures.authorized.certPath, "--allow-missing-inputs"], {
      env: { ...process.env },
      stdout: new Recorder(),
      stderr,
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /a provisioning profile is required/);
  });
});

describe("reading the material", () => {
  // security(1) is macOS-only, so the release path would be untestable if this
  // were the only decoder. Forcing the openssl decoder proves the fallback that
  // Linux CI uses is the same code the runners exercise.
  test("a CMS-wrapped profile decodes without security(1)", () => {
    const decoded = decodeProvisioningProfile(readFileSync(fixtures.profilePath), {
      security: "/nonexistent/security",
    });
    assert.match(decoded.decoder, /^openssl /);
    assert.equal(readProfile(decoded.plist).uuid, profile.uuid);
  });

  test("an already-decoded plist is accepted as-is", () => {
    const decoded = decodeProvisioningProfile(readFileSync(fixtures.plistPath));
    assert.equal(decoded.decoder, "already-decoded");
  });

  test("an undecodable profile fails rather than parsing to nothing", () => {
    assert.throws(
      () => decodeProvisioningProfile(Buffer.from("not a provisioning profile at all")),
      /could not decode the provisioning profile/,
    );
  });

  test("a binary plist says what to do instead of misreporting", () => {
    assert.throws(
      () => decodeProvisioningProfile(Buffer.from("bplist00  ")),
      /plutil -convert xml1/,
    );
  });

  test("the fingerprint is the SHA-1 openssl prints", () => {
    const openssl = spawnSync(
      "openssl",
      ["x509", "-in", fixtures.authorized.certPath, "-noout", "-fingerprint", "-sha1"],
      { encoding: "utf8" },
    );
    assert.equal(openssl.status, 0, openssl.stderr);
    assert.equal(
      openssl.stdout.trim().split("=").slice(1).join("=").toUpperCase(),
      certificateFingerprintSha1(fixtures.authorized.der),
    );
  });

  test("the plist reader handles the element set Apple emits", () => {
    const parsed = parsePlistXml(`<?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0"><dict>
        <key>Name</key><string>A &amp; B &lt;x&gt;</string>
        <key>Count</key><integer>3</integer>
        <key>Ratio</key><real>0.5</real>
        <key>Yes</key><true/>
        <key>No</key><false/>
        <key>When</key><date>2027-08-08T20:33:04Z</date>
        <key>Blob</key><data>aGVsbG8=</data>
        <key>List</key><array><string>one</string><dict><key>k</key><string>v</string></dict></array>
        <key>Empty</key><array/>
      </dict></plist>`);
    assert.equal(parsed.get("Name"), "A & B <x>");
    assert.equal(parsed.get("Count"), 3);
    assert.equal(parsed.get("Ratio"), 0.5);
    assert.equal(parsed.get("Yes"), true);
    assert.equal(parsed.get("No"), false);
    assert.equal(parsed.get("When").toISOString(), "2027-08-08T20:33:04.000Z");
    assert.equal(parsed.get("Blob").toString("utf8"), "hello");
    assert.equal(parsed.get("List")[1].get("k"), "v");
    assert.deepEqual(parsed.get("Empty"), []);
  });

  test("an element the reader does not understand is an error, not a silent omission", () => {
    assert.throws(
      () => parsePlistXml("<plist><dict><key>k</key><uid>1</uid></dict></plist>"),
      /unsupported plist element <uid>/,
    );
  });

  test("a DeveloperCertificates entry that is not <data> is an error", () => {
    assert.throws(
      () =>
        readProfile(
          "<plist><dict><key>DeveloperCertificates</key><array><string>nope</string></array></dict></plist>",
        ),
      /not <data>/,
    );
  });

  test("a truncated certificate in the profile is an error, not an unauthorized-looking pass", () => {
    const broken = readFileSync(fixtures.plistPath, "utf8").replace(
      fixtures.authorized.der.toString("base64"),
      fixtures.authorized.der.subarray(0, 40).toString("base64"),
    );
    assert.throws(() => readProfile(broken));
  });
});

describe("the release path uses this file", () => {
  test("--self-test passes, so a release job can prove the check before trusting it", () => {
    const lines = [];
    assert.equal(selfTest({ log: (line) => lines.push(line) }), 0, lines.join("\n"));
    assert.ok(lines.some((line) => line.includes("a certificate no profile authorizes is rejected")));
  });

  test("--self-test fails when the check is broken", () => {
    // Prove the self-test is load-bearing: break the fixture material it
    // depends on and it must go red rather than sail through.
    const scratch = mkdtempSync(join(tmpdir(), "verify-signing-identity-broken."));
    try {
      const shim = join(scratch, "openssl");
      writeFileSync(shim, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const lines = [];
      assert.equal(selfTest({ log: (line) => lines.push(line), openssl: shim }), 1);
      assert.ok(lines.some((line) => line.startsWith("  FAIL")));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("both release workflows invoke the preflight before exporting the archive", () => {
    const repoRoot = new URL("..", import.meta.url);
    for (const [workflow, bundleId] of [
      [".github/workflows/zuuli-release.yml", "cash.free2z.zuuli"],
      [".github/workflows/e2e2z-release.yml", "cash.free2z.e2e2z"],
    ]) {
      const source = readFileSync(new URL(workflow, repoRoot), "utf8");
      const preflight = source.indexOf("verify-signing-identity.mjs --self-test");
      const verdict = source.indexOf("--keychain-identity-sha1");
      const exportArchive = source.indexOf("xcodebuild -exportArchive");
      assert.ok(preflight > 0, `${workflow} does not self-test the signing preflight`);
      assert.ok(verdict > preflight, `${workflow} does not run the signing preflight`);
      assert.ok(
        verdict < exportArchive,
        `${workflow} runs the signing preflight after xcodebuild -exportArchive, which is too late`,
      );
      assert.ok(
        source.includes(`--bundle-id ${bundleId}`),
        `${workflow} does not bind the preflight to ${bundleId}`,
      );
    }
  });
});
