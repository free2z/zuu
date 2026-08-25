import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const EXPECTED_LINUX_ARTIFACT_FIXTURE_COUNT = 4;
const EXPECTED_LINUX_ARTIFACT_FIXTURE_PATTERN =
  "^(?:real AppImage, deb, and rpm fixtures expose undeclared shipped canaries|AppImage inspection fails closed on ELF arithmetic and SquashFS boundary mutations|AppImage listing rejects a SquashFS member with invalid UTF-8 bytes|a real deb with an escaping payload symlink fails before extraction)$";

export const REQUIRE_LINUX_ARTIFACT_FIXTURES =
  "ZUULI_REQUIRE_LINUX_ARTIFACT_FIXTURES";
export const LINUX_ARTIFACT_FIXTURE_TITLES = Object.freeze([
  "real AppImage, deb, and rpm fixtures expose undeclared shipped canaries",
  "AppImage inspection fails closed on ELF arithmetic and SquashFS boundary mutations",
  "AppImage listing rejects a SquashFS member with invalid UTF-8 bytes",
  "a real deb with an escaping payload symlink fails before extraction",
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function linuxArtifactFixturePattern() {
  const uniqueTitles = new Set(LINUX_ARTIFACT_FIXTURE_TITLES);
  if (
    LINUX_ARTIFACT_FIXTURE_TITLES.length !==
      EXPECTED_LINUX_ARTIFACT_FIXTURE_COUNT ||
    uniqueTitles.size !== EXPECTED_LINUX_ARTIFACT_FIXTURE_COUNT
  ) {
    throw new Error(
      `Linux artifact fixture selector must contain exactly ${EXPECTED_LINUX_ARTIFACT_FIXTURE_COUNT} unique titles`,
    );
  }
  return `^(?:${LINUX_ARTIFACT_FIXTURE_TITLES.map(escapeRegExp).join("|")})$`;
}

export function runLinuxArtifactFixtures({ spawn = spawnSync } = {}) {
  const pattern = linuxArtifactFixturePattern();
  if (pattern !== EXPECTED_LINUX_ARTIFACT_FIXTURE_PATTERN) {
    throw new Error(
      "Linux artifact fixture selector does not match its independent exact authority",
    );
  }
  const result = spawn(
    process.execPath,
    [
      "--test",
      `--test-name-pattern=${pattern}`,
      resolve(scriptDirectory, "artifact-sbom.node-test.mjs"),
    ],
    {
      env: {
        ...process.env,
        [REQUIRE_LINUX_ARTIFACT_FIXTURES]: "1",
      },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Linux artifact fixture test process exited with status ${result.status}`,
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    runLinuxArtifactFixtures();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
