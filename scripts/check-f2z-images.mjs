#!/usr/bin/env node
//
// The image supply chain for the messaging and AI server binaries, held to its
// contract in one place.
//
// `rs/Dockerfile` builds `f2z-relay`, `f2z-kt`, `f2z-witness` and `f2z-ai` into
// digest-pinned distroless images, and `.github/workflows/f2z-images.yml`
// publishes them with an SBOM, `provenance: mode=max` and a pushed attestation.
// Neither file fails loudly when it stops being right:
//
//   * A `paths:` filter that has drifted is a workflow that has silently
//     stopped publishing. GitHub does not run it, no job goes red, and the
//     images simply stop being rebuilt. This is the failure this script exists
//     for first — see `pathFilterFailures`.
//   * An action reference that loses its 40-hex pin is a mutable dependency in
//     the build of a server binary, which is the supply chain the SBOM and the
//     attestation were added to describe.
//   * A base image that loses its digest pin, or a runtime that goes back to
//     root, or a `cargo build` that loses `--locked`, all still produce a
//     working image. They just produce a *different* one than the one that was
//     reviewed.
//   * The Rust version restated in YAML or in a Dockerfile is the drift
//     `scripts/check-rust-toolchain.sh` exists to prevent, so it must not
//     appear in either file at all.
//
// Modes:
//
//   (no argument)        Enforce the policy over this repository.
//   --self-test          Prove every rule above still fails on a broken copy.
//   --inspect IMG BIN    Assert a built image's shape: entrypoint, uid, the
//                        absence of a shell, and that the binary runs.
//   --probe IMG          Assert the f2z-witness `exec` probe contract inside
//                        the image, for BOTH the readiness verdict and the
//                        narrower `--liveness yes` one the manifests use.
//   --probe-relay IMG    Start f2z-relay in the image with the configuration
//                        k8s/f2z-relay/deployment.yaml sets, and assert that a
//                        Kubernetes probe can actually reach `/healthz` — on
//                        the health port and NOT on the protocol port.
//
// The probe modes run against a container and are what the workflow calls after a
// build; the first two are pure file inspection and run anywhere.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const dockerfilePath = "rs/Dockerfile";
const dockerignorePath = "rs/.dockerignore";
const workflowPath = ".github/workflows/f2z-images.yml";
const toolchainPath = "rust-toolchain.toml";
const workspaceToolchainPath = "rs/rust-toolchain.toml";
const denyPath = "rs/deny.toml";
const gateRegistryPath = "scripts/check-workflow-gates.mjs";
const readmePath = "rs/README.md";

/// The AGPL-3.0 server binaries. Each is a crate name, a `[[bin]]` name,
/// an image repository name and the absolute path the deployment probes — one
/// string, on purpose, so an operator reading a `livenessProbe` argv and an
/// operator reading an image reference are reading the same word.
const SERVER_BINARIES = ["f2z-relay", "f2z-kt", "f2z-witness", "f2z-ai"];

/// The image namespace. Not derived from the workflow: otherwise editing the
/// workflow would edit both the input and its expected value.
const IMAGE_NAMESPACE = "ghcr.io/free2z";

/// The runtime base. `cc`, not `static`, because `rusqlite` bundles SQLite and
/// every binary links libc; `nonroot`, because uid 65532 is
/// what the manifests expect to see in a `runAsUser`.
const RUNTIME_BASE = "gcr.io/distroless/cc-debian12:nonroot";

/// The builder base. **bookworm is load-bearing**: the runtime is
/// distroless/cc-debian12, which is bookworm, and a builder on a newer Debian
/// links a newer glibc and yields a binary that starts on the build host and
/// dies on the cluster.
const BUILDER_BASE = "docker.io/library/rust:1-slim-bookworm";

/// The uid distroless `:nonroot` runs as, and the one the deployment's
/// `securityContext` names.
const NONROOT_UID = "65532";

/// Reviewed action pins. Each must appear verbatim, comment included: the
/// trailing `# vX.Y.Z` is how a reviewer reads a 40-hex reference, and
/// `scripts/check-github-actions-pins.mjs` requires the pin while this requires
/// the *reviewed* pin.
const REVIEWED_ACTION_PINS = [
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
  "docker/setup-buildx-action@37fe631027851001ddb9b187196cc803df7f5f0e # v4.3.0",
  "docker/login-action@dbcb813823bdd20940b903addbd779551569679f # v4.6.0",
  "docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0",
  "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4.2.2",
];

/// Paths that MUST select this workflow. The first four are the whole reason
/// the check exists: a filter that no longer matches a crate source file is a
/// workflow that stopped publishing without anything going red.
const REQUIRED_TRIGGER_PATHS = [
  "rs/Dockerfile",
  "rs/Cargo.lock",
  "rs/crates/f2z-relay/src/main.rs",
  "rs/crates/f2z-witness/src/health.rs",
  "rs/crates/f2z-kt/Cargo.toml",
  "rs/crates/f2z-ai/src/main.rs",
  ".github/workflows/f2z-images.yml",
  "scripts/check-f2z-images.mjs",
  "scripts/check-rust-toolchain.sh",
  "rust-toolchain.toml",
];

/// The negative control for the filter. A path under `wallet/zuuli/` cannot
/// change any of these images, and a filter that matched it would rebuild three
/// server images on every frontend commit — which is how a `paths:` list stops
/// meaning anything and then gets deleted.
const FORBIDDEN_TRIGGER_PATHS = [
  "wallet/zuuli/src/App.tsx",
  "ts/react-free2z/package.json",
  "docs/README.md",
];

const REQUIRED_WORKFLOW_STRINGS = [
  "platforms: linux/amd64",
  "sbom: true",
  "provenance: mode=max",
  "push-to-registry: true",
  "packages: write",
  "id-token: write",
  "attestations: write",
  "artifact-metadata: write",
  "subject-digest: ${{ steps.publish.outputs.digest }}",
  "context: rs",
  "file: rs/Dockerfile",
  "BIN=${{ matrix.bin }}",
  "RUST_CHANNEL=${{ steps.rust_toolchain.outputs.version }}",
  "scripts/check-rust-toolchain.sh --print-channel",
  "build-${{ github.run_id }}-${{ github.run_attempt }}",
  "$GITHUB_STEP_SUMMARY",
  'run: node scripts/check-f2z-images.mjs --probe-ai "$IMAGE"',
  'node scripts/check-f2z-images.mjs --probe-ai "$IMAGE_REPOSITORY@$IMAGE_DIGEST"',
];

const REQUIRED_DOCKERFILE_STRINGS = [
  "cargo build --locked --release --package",
  `USER ${NONROOT_UID}:${NONROOT_UID}`,
  'org.opencontainers.image.licenses="AGPL-3.0-only"',
  "FROM bin-${BIN}",
];

function read(root, path) {
  return readFileSync(resolve(root, path), "utf8");
}

/// Whole-line comments removed, blanked rather than deleted so a reported line
/// number still means something.
///
/// The forbidden-pattern rules below run over this and not over the raw file,
/// because both files explain *why* the forbidden thing is forbidden — the
/// Dockerfile says what `cargo build` embeds, the workflow says why there is no
/// `:latest` — and a check that could not tell an explanation from an
/// instruction would force those explanations to be deleted.
export function withoutComments(text) {
  return text
    .split("\n")
    .map((line) => (line.trimStart().startsWith("#") ? "" : line))
    .join("\n");
}

/// GitHub's `paths:` glob semantics, narrowed to what this repository writes:
/// `**` crosses `/`, `*` does not, everything else is literal.
export function pathFilterMatches(pattern, path) {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000", ".*");
  return new RegExp(`^${source}$`).test(path);
}

/// Every `paths:` list under `on:`, as `{ event, patterns }`.
///
/// Parsed by hand rather than with a YAML library because this repository's
/// checks do not take dependencies to read four lines of indentation, and
/// because a parser that silently accepted a malformed block would defeat the
/// point: an unreadable `paths:` is reported, not skipped.
export function triggerPathFilters(workflow) {
  const lines = workflow.split("\n");
  const onStart = lines.findIndex((line) => line === "on:");
  const filters = [];
  if (onStart < 0) return filters;

  let event = null;
  for (let index = onStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== "" && !line.startsWith(" ")) break;
    const eventMatch = line.match(/^ {2}([a-z_]+):/);
    if (eventMatch) event = eventMatch[1];
    if (!/^ {4}paths:\s*$/.test(line)) continue;

    const patterns = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const item = lines[cursor].match(/^ {6}- (\S+)\s*$/);
      if (!item) break;
      // `- '**'` and `- "**"` are the same filter as `- **`; YAML quoting is
      // not part of the glob, and a rule that could be evaded by adding quotes
      // would be worse than no rule.
      patterns.push(item[1].replace(/^(['"])(.*)\1$/, "$2"));
    }
    filters.push({ event, patterns });
  }
  return filters;
}

/// The `paths:` rule, stated once for both events that carry one.
///
/// A filter drifts in two directions and only one of them is visible. Too
/// narrow and the workflow stops running — nothing goes red, the images just
/// stop being rebuilt, and the deployment keeps pulling a digest nobody has
/// rebuilt in months. Too wide and it rebuilds three server images on every
/// frontend commit until someone deletes the filter in irritation. Both are
/// checked, because only asserting the first invites the second.
export function pathFilterFailures(workflow) {
  const failures = [];
  const filters = triggerPathFilters(workflow);
  const events = filters.map((filter) => filter.event).sort();
  if (events.join(",") !== "pull_request,push") {
    failures.push(
      `workflow: expected a paths: filter on exactly pull_request and push, found [${events.join(", ")}]`,
    );
  }
  for (const { event, patterns } of filters) {
    if (!patterns.some((pattern) => pattern.startsWith("rs/"))) {
      failures.push(`workflow: the ${event} paths: filter does not cover rs/** at all`);
    }
    for (const path of REQUIRED_TRIGGER_PATHS) {
      if (!patterns.some((pattern) => pathFilterMatches(pattern, path))) {
        failures.push(
          `workflow: the ${event} paths: filter does not select ${path}; ` +
            "a drifted filter is a workflow that has silently stopped publishing",
        );
      }
    }
    for (const path of FORBIDDEN_TRIGGER_PATHS) {
      if (patterns.some((pattern) => pathFilterMatches(pattern, path))) {
        failures.push(
          `workflow: the ${event} paths: filter selects ${path}, which cannot change any server image`,
        );
      }
    }
  }
  return failures;
}

export function actionPinFailures(workflow) {
  const failures = [];
  for (const match of workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)(\s+#.*)?$/gm)) {
    const [, reference, comment] = match;
    if (reference.startsWith("./")) continue;
    if (!/@[0-9a-f]{40}$/.test(reference)) {
      failures.push(`workflow: action is not commit-pinned to a 40-hex sha: ${reference}`);
      continue;
    }
    if (!/^\s+# v\d+\.\d+\.\d+\s*$/.test(comment ?? "")) {
      failures.push(
        `workflow: ${reference} has no trailing "# vX.Y.Z" comment; a bare 40-hex ` +
          "reference tells a reviewer nothing about what it is",
      );
    }
  }
  for (const pin of REVIEWED_ACTION_PINS) {
    if (!workflow.includes(pin)) failures.push(`workflow: missing reviewed action pin: ${pin}`);
  }
  return failures;
}

export function dockerfileFailures(dockerfile, channel) {
  const failures = [];
  const froms = [...dockerfile.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?\s*$/gm)];
  const stages = new Set(froms.map(([, , alias]) => alias).filter(Boolean));

  const argIndex = dockerfile.search(/^ARG BIN$/m);
  const firstFrom = dockerfile.search(/^FROM /m);
  if (argIndex < 0 || firstFrom < 0 || argIndex > firstFrom) {
    failures.push(
      "Dockerfile: `ARG BIN` must be declared before the first FROM, or `FROM bin-${BIN}` cannot resolve",
    );
  }

  for (const [, reference] of froms) {
    const base = reference.replace(/^bin-\$\{BIN\}$/, "");
    if (base === "" || stages.has(reference)) continue;
    if (!/@sha256:[0-9a-f]{64}$/.test(reference)) {
      failures.push(`Dockerfile: base image is not digest-pinned: ${reference}`);
    }
  }
  if (!dockerfile.includes(`FROM ${RUNTIME_BASE}@sha256:`)) {
    failures.push(`Dockerfile: the runtime base must be ${RUNTIME_BASE}, digest-pinned`);
  }
  if (!dockerfile.includes(`FROM ${BUILDER_BASE}@sha256:`)) {
    failures.push(
      `Dockerfile: the builder base must be ${BUILDER_BASE}, digest-pinned; the runtime is ` +
        "bookworm and a newer builder links a glibc the cluster does not have",
    );
  }

  for (const bin of SERVER_BINARIES) {
    if (!stages.has(`bin-${bin}`)) {
      failures.push(`Dockerfile: no per-binary stage bin-${bin}`);
    }
    if (!dockerfile.includes(`COPY --from=build /out/${bin} /${bin}`)) {
      failures.push(`Dockerfile: ${bin} must land at the absolute path /${bin}`);
    }
    if (!dockerfile.includes(`ENTRYPOINT ["/${bin}"]`)) {
      failures.push(
        `Dockerfile: bin-${bin} must ENTRYPOINT ["/${bin}"]; exec-form ENTRYPOINT does not ` +
          "expand build arguments, which is why there is a stage per binary",
      );
    }
  }

  for (const expected of REQUIRED_DOCKERFILE_STRINGS) {
    if (!dockerfile.includes(expected)) failures.push(`Dockerfile: missing ${expected}`);
  }

  const instructions = withoutComments(dockerfile);
  for (const [label, pattern] of [
    ["cache mount", /--mount=type=cache/],
    ["ADD", /^\s*ADD\s/m],
    ["root user", /^\s*USER\s+(root|0)\s*$/m],
    ["secret", /\b(GITHUB_TOKEN|password|credential)\b/],
    ["unlocked cargo build", /cargo build(?![^\n]*--locked)/],
  ]) {
    if (pattern.test(instructions)) failures.push(`Dockerfile: forbidden ${label}`);
  }

  if (dockerfile.includes(channel)) {
    failures.push(
      `Dockerfile: restates the Rust channel ${channel}; it must arrive as the RUST_CHANNEL ` +
        "build-arg from scripts/check-rust-toolchain.sh --print-channel",
    );
  }
  if (!/reproducib/i.test(dockerfile)) {
    failures.push(
      "Dockerfile: must state what the attestation does and does not prove; provenance is not " +
        "reproducibility and the difference is worth writing down",
    );
  }
  return failures;
}

export function workflowFailures(workflow, channel) {
  const failures = [...actionPinFailures(workflow), ...pathFilterFailures(workflow)];

  for (const expected of REQUIRED_WORKFLOW_STRINGS) {
    if (!workflow.includes(expected)) failures.push(`workflow: missing ${expected}`);
  }
  if (!new RegExp(`^  IMAGE_NAMESPACE: ${IMAGE_NAMESPACE}$`, "m").test(workflow)) {
    failures.push(`workflow: images must publish under ${IMAGE_NAMESPACE}`);
  }
  if (!workflow.includes("${{ env.IMAGE_NAMESPACE }}/${{ matrix.bin }}")) {
    failures.push(
      "workflow: the published repository must be the namespace joined to the matrix binary, " +
        "so an image name and the argv an operator probes cannot drift apart",
    );
  }
  for (const bin of SERVER_BINARIES) {
    if (!new RegExp(`^\\s+bin: \\[[^\\]]*\\b${bin}\\b`, "m").test(workflow)) {
      failures.push(`workflow: ${bin} is not in the build matrix`);
    }
  }
  const directives = withoutComments(workflow);
  if (/:latest\b/.test(directives)) {
    failures.push(
      "workflow: a `:latest` tag is a way to deploy something nobody chose; publish the " +
        "commit-scoped and build-scoped tags only",
    );
  }
  if (/platforms:[^\n]*arm64/.test(directives)) {
    failures.push(
      "workflow: linux/amd64 is the reviewed platform for the target cluster; adding an " +
        "architecture publishes new digests and is a reviewed change, not an incidental one",
    );
  }
  if (workflow.includes(channel)) {
    failures.push(
      `workflow: restates the Rust channel ${channel}; read it with ` +
        "scripts/check-rust-toolchain.sh --print-channel instead",
    );
  }
  if (!/if: >-\s*\n\s*github\.ref == 'refs\/heads\/main'/.test(workflow)) {
    failures.push("workflow: the publish job must be gated to refs/heads/main");
  }
  if (!workflow.includes("if: github.event_name == 'pull_request'")) {
    failures.push("workflow: the build-and-inspect job must be gated to pull_request");
  }
  if (workflow.includes("push: true") && !workflow.includes("push: false")) {
    failures.push(
      "workflow: the pull-request leg must build with push: false; a pull request that could " +
        "push to the registry is a pull request that can publish an unreviewed image",
    );
  }
  return failures;
}

export function crossFileFailures(root) {
  const failures = [];
  const deny = read(root, denyPath);
  const gateRegistry = read(root, gateRegistryPath);
  const readme = read(root, readmePath);
  const dockerignore = read(root, dockerignorePath);

  for (const bin of SERVER_BINARIES) {
    const manifest = read(root, `rs/crates/${bin}/Cargo.toml`);
    if (!/^license = "AGPL-3\.0(-only)?"$/m.test(manifest)) {
      failures.push(
        `${bin}: only AGPL-3.0 server binaries belong in an image published from this ` +
          "workflow; a permissive library crate here would be a licence-boundary failure",
      );
    }
    if (!new RegExp(`name = "${bin}"`).test(deny)) {
      failures.push(`rs/deny.toml: ${bin} is not named in the licence exceptions`);
    }
  }

  if (!gateRegistry.includes(workflowPath)) {
    failures.push(
      `${gateRegistryPath}: ${workflowPath} publishes no gate and is not registered in ` +
        "UNGATED_WORKFLOWS; a workflow with no gate presents nothing to be wrong about",
    );
  }
  if (!readme.includes(dockerfilePath)) {
    failures.push(`${readmePath}: does not document ${dockerfilePath}`);
  }
  if (!/^target\/$/m.test(dockerignore)) {
    failures.push(
      `${dockerignorePath}: must exclude target/, or a developer's local build output is ` +
        "uploaded into the build context",
    );
  }
  return failures;
}

export function validate(root) {
  const channel = read(root, toolchainPath).match(/^channel = "([^"]+)"$/m)?.[1];
  const failures = [];
  if (!channel) {
    failures.push(`${toolchainPath}: no channel to compare against`);
    return failures;
  }
  const restated = read(root, workspaceToolchainPath).match(/^channel = "([^"]+)"$/m)?.[1];
  if (restated !== channel) {
    failures.push(
      `${workspaceToolchainPath} restates ${restated}, not ${channel}; the image build reads the ` +
        "workspace file, so the two disagreeing means the image is built by an unreviewed compiler",
    );
  }

  failures.push(...dockerfileFailures(read(root, dockerfilePath), channel));
  failures.push(...workflowFailures(read(root, workflowPath), channel));
  failures.push(...crossFileFailures(root));
  return failures;
}

// ---------------------------------------------------------------------------
// Container assertions. These run in CI, against an image that was just built.
// ---------------------------------------------------------------------------

function docker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/// The shape of a built image, asserted against the container rather than the
/// Dockerfile — a `docker build` that succeeded is not evidence that the thing
/// it produced runs.
function inspectImage(image, bin) {
  const failures = [];
  const config = docker([
    "image",
    "inspect",
    "--format",
    "{{json .Config.Entrypoint}}\t{{.Config.User}}\t{{.Architecture}}\t{{.Os}}",
    image,
  ]);
  if (config.status !== 0) {
    return [`docker image inspect ${image} failed: ${config.stderr.trim()}`];
  }
  const [entrypoint, user, architecture, os] = config.stdout.trim().split("\t");
  if (entrypoint !== JSON.stringify([`/${bin}`])) {
    failures.push(`${image}: entrypoint is ${entrypoint}, expected ["/${bin}"]`);
  }
  if (!user.startsWith(NONROOT_UID)) {
    failures.push(`${image}: runs as ${user || "root"}, expected uid ${NONROOT_UID}`);
  }
  if (`${os}/${architecture}` !== "linux/amd64") {
    failures.push(`${image}: is ${os}/${architecture}, expected linux/amd64`);
  }

  // The binary starts, links, and answers. `--help` is the cheapest invocation
  // that exercises the dynamic loader against the distroless runtime, which is
  // the thing most likely to be wrong after a base-image change.
  const help = docker(["run", "--rm", image, "--help"]);
  if (help.status !== 0) {
    failures.push(
      `${image}: \`--help\` exited ${help.status}: ${(help.stderr || help.stdout).trim()}`,
    );
  } else if (!help.stdout.includes(bin)) {
    failures.push(`${image}: \`--help\` does not name ${bin}`);
  }

  // No shell. This is not tidiness: it is the premise of the witness's `exec`
  // probe, and the moment a shell appears somebody will write a probe that
  // pipes something.
  for (const shell of ["/bin/sh", "/bin/bash"]) {
    const attempt = docker(["run", "--rm", "--entrypoint", shell, image, "-c", "echo reachable"]);
    if (attempt.status === 0) {
      failures.push(`${image}: ${shell} is present; the runtime must stay distroless`);
    }
  }
  return failures;
}

/// The liveness contract of `rs/crates/f2z-witness/src/health.rs`, asserted
/// against the published image.
///
/// The deployment probes with
/// `exec: ["/f2z-witness", "healthz", "--state", "/var/lib/f2z-witness/state.bin"]`
/// because the image has no shell and KT.md §9.3 promises the daemon has no
/// inbound listener to dial. Two things are checked, and the second is the one
/// that matters:
///
///   1. `healthz` dispatches inside the container — the binary is at the path
///      the manifest names, execs without a shell, and resolves its libraries.
///   2. With no state file it reports **UNPINNED and exits 1**. A probe that
///      passed before the witness had ever completed a poll would mark a
///      never-started witness healthy, which is the failure the subcommand
///      exists to make visible.
///
/// It does not attempt the `Following` case: producing one requires a real log
/// serving real proofs, which is what `rs/crates/f2z-witness`'s acceptance test
/// does under `cargo test`. What that test cannot show, and this can, is that
/// the probe works when there is no shell to fall back on.
function probeWitness(image) {
  const failures = [];
  const probe = ["healthz", "--state", "/var/lib/f2z-witness/state.bin"];

  const unpinned = docker(["run", "--rm", image, ...probe]);
  const output = `${unpinned.stdout}${unpinned.stderr}`;
  if (unpinned.status === null) {
    failures.push(`${image}: the exec probe did not run at all`);
    return failures;
  }
  if (!output.includes("UNPINNED")) {
    failures.push(
      `${image}: the exec probe ${JSON.stringify(probe)} did not report a witness verdict; ` +
        `got exit ${unpinned.status} and ${JSON.stringify(output.trim())}`,
    );
  }
  if (unpinned.status !== 1) {
    failures.push(
      `${image}: a witness with no state file must fail the probe, got exit ${unpinned.status}`,
    );
  }

  // `--state` is required, and the manifests must pass it. A probe written as
  // ["/f2z-witness", "healthz"] would fail permanently, which is a different
  // and much worse failure than an unhealthy witness.
  const bare = docker(["run", "--rm", image, "healthz"]);
  if (bare.status === 0) {
    failures.push(
      `${image}: \`healthz\` with no --state exited 0; the probe must not pass without being ` +
        "told which state file to read",
    );
  }

  // `--liveness yes` is the argv the manifests' startup and liveness probes
  // use, and its whole purpose is that UNPINNED — "the log has not been
  // reachable yet" — must NOT restart the pod. If this ever exits 1 again, a
  // witness deployed before its log's Ingress exists goes into a permanent
  // ~20-minute restart cycle, and its state file is the evidence somebody
  // wants during exactly that incident. See f2z-witness/src/health.rs.
  const liveness = docker(["run", "--rm", image, ...probe, "--liveness", "yes"]);
  if (liveness.status !== 0) {
    failures.push(
      `${image}: \`healthz --liveness yes\` on a witness that has never polled exited ` +
        `${liveness.status}; UNPINNED is a statement about the LOG and must not restart this pod`,
    );
  }
  if (!`${liveness.stdout}${liveness.stderr}`.includes("UNPINNED")) {
    failures.push(
      `${image}: \`healthz --liveness yes\` passed without printing the verdict; a liveness ` +
        "probe that passes on STALE must still SAY STALE",
    );
  }
  // The value is mandatory, for the reason `--allow-cleartext` requires one.
  const bareLiveness = docker(["run", "--rm", image, ...probe, "--liveness"]);
  if (bareLiveness.status === 0) {
    failures.push(`${image}: \`--liveness\` with no value exited 0; it must take \`yes\``);
  }
  return failures;
}

/// The relay's Kubernetes probe contract, asserted against a running container.
///
/// This is the check that did not exist when `k8s/f2z-relay/deployment.yaml`
/// was written, and its absence is why that manifest specified three `httpGet`
/// probes against `/healthz` on the protocol port and a GCE health check
/// against the same — none of which the binary could answer. `/healthz` lived
/// on a listener that refuses to bind off loopback, and the kubelet and the
/// load balancer both dial the pod IP.
///
/// So the two assertions here are the two halves of that mistake:
///
///   * `/healthz` MUST answer 200 on the health port, bound to `0.0.0.0`;
///   * `/healthz` MUST NOT be answerable on the protocol port, so nobody
///     re-points a probe at it and gets a green CI run.
///
/// And `/metrics` must be a 404 on the health port: the loopback rule exists
/// for the metrics endpoint, and none of this relaxes it.
async function probeRelay(image) {
  const failures = [];
  const args = [
    "run",
    // NOT `--rm`: a container that exits on its own arguments would be reaped
    // before its logs could be read, and those logs are the whole diagnosis.
    // The `finally` below removes it either way.
    "-d",
    "-p",
    "127.0.0.1:0:8080",
    "-p",
    "127.0.0.1:0:8081",
    image,
    // Exactly what the Deployment's environment resolves to: TLS terminated by
    // the load balancer, the protocol listener on the NEG's serving port, the
    // health listener on a second declared containerPort.
    "--listen",
    "0.0.0.0:8080",
    "--insecure-listen",
    "--health-listen",
    "0.0.0.0:8081",
    // The store and the identity are the deployment's PVC in production; a
    // container with no volume is the shape this check can run in.
    "--store",
    "memory",
    "--identity",
    "/tmp/identity.key",
  ];
  const started = docker(args);
  if (started.status !== 0) {
    return [`${image}: the relay did not start: ${(started.stderr || started.stdout).trim()}`];
  }
  const container = started.stdout.trim();
  try {
    const portOf = (containerPort) => {
      const mapped = docker(["port", container, containerPort]);
      const match = /:(\d+)\s*$/.exec(mapped.stdout.trim().split("\n")[0] ?? "");
      return match ? Number(match[1]) : null;
    };
    // Did it survive its own arguments? This is the failure mode an activation
    // PR is most likely to hit — a digest pinned from a commit that predates
    // `--health-listen` exits immediately with `unknown flag --health-listen`,
    // and reporting that as "no published ports" would send somebody looking
    // at Docker networking instead of at the digest.
    const running = docker(["inspect", "--format", "{{.State.Running}}", container]);
    if (running.stdout.trim() !== "true") {
      const logs = docker(["logs", container]);
      return [
        `${image}: the relay exited instead of serving: ` +
          JSON.stringify(`${logs.stdout}${logs.stderr}`.trim()),
      ];
    }

    const healthPort = portOf("8081");
    const protocolPort = portOf("8080");
    if (!healthPort || !protocolPort) {
      return [`${image}: docker did not publish both ports (${healthPort}, ${protocolPort})`];
    }

    // `node:http` with `agent: false`, NOT `fetch`. The relay's operational
    // listener answers ONE request per connection and closes — no keep-alive,
    // deliberately, because one request per connection is all a scraper needs
    // and it is one fewer state machine on the listener. `fetch` pools sockets
    // and reuses them, so the SECOND request here failed roughly one run in
    // five with a connection error that looked exactly like a broken endpoint.
    // A flaky check is worse than no check, so this opens a fresh socket per
    // request — which is also what the kubelet and the GCE health checker do.
    const get = (port, path) =>
      new Promise((resolve_) => {
        const request = httpRequest(
          { host: "127.0.0.1", port, path, method: "GET", agent: false, timeout: 3000 },
          (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
              body += chunk;
            });
            response.on("end", () => resolve_({ status: response.statusCode, body }));
          },
        );
        request.on("timeout", () => request.destroy());
        request.on("error", () => resolve_({ status: null, body: "" }));
        request.end();
      });

    // The relay opens a store and an identity before it binds, so give it the
    // same grace a startupProbe does rather than racing it.
    let health = { status: null, body: "" };
    for (let attempt = 0; attempt < 30; attempt += 1) {
      health = await get(healthPort, "/healthz");
      if (health.status !== null) break;
      await new Promise((resolve_) => setTimeout(resolve_, 500));
    }
    if (health.status !== 200) {
      failures.push(
        `${image}: GET /healthz on the health port returned ${health.status}; the kubelet and ` +
          "the GCE health check both dial this and both must get a 200",
      );
    } else if (health.body !== "ok\n") {
      failures.push(`${image}: /healthz answered ${JSON.stringify(health.body)}, expected "ok\\n"`);
    }

    const metrics = await get(healthPort, "/metrics");
    if (metrics.status !== 404) {
      failures.push(
        `${image}: /metrics on the health port returned ${metrics.status}, expected 404; the ` +
          "loopback rule exists for the metrics endpoint and this must not relax it",
      );
    }

    // The measurement that started all of this: the protocol port speaks
    // WebSocket, and a plain GET gets nothing. Asserted so a future edit that
    // "simplifies" the two ports into one has to change this line and read why.
    const onProtocol = await get(protocolPort, "/healthz");
    if (onProtocol.status === 200) {
      failures.push(
        `${image}: /healthz answered 200 on the protocol port; probes must point at the health ` +
          "port, and the unauthenticated WebSocket listener must not grow an HTTP surface",
      );
    }
  } finally {
    docker(["rm", "-f", container]);
  }
  return failures;
}

// Exercise the runtime image without service credentials. Closed readiness is
// intentional here: this is image/health/shutdown proof, not paid-call acceptance.
async function probeAi(image) {
  const started = docker(["run", "-d", "--read-only", "--cap-drop=ALL",
    "--security-opt=no-new-privileges", "-p", "127.0.0.1::8080", "-p", "127.0.0.1::9090",
    "-e", "F2Z_AI_LISTEN=0.0.0.0:8080", "-e", "F2Z_AI_ADMIN_LISTEN=0.0.0.0:9090",
    "-e", "F2Z_AI_DRAIN_TIMEOUT_SECS=1", image]);
  if (started.status !== 0) return [`${image}: gateway failed to start: ${started.stderr}`];
  const container = started.stdout.trim();
  const failures = [];
  try {
    const port = (n) => Number(/:(\d+)\s*$/.exec(docker(["port", container, String(n)]).stdout)?.[1]);
    const publicPort = port(8080), adminPort = port(9090);
    if (!publicPort || !adminPort) return [`${image}: gateway ports not published`];
    const get = (p, path) => new Promise((resolve_) => {
      const req = httpRequest({host: "127.0.0.1", port: p, path, agent: false, timeout: 1000}, res => {
        res.resume(); res.on("end", () => resolve_(res.statusCode));
      });
      req.on("timeout", () => req.destroy()); req.on("error", () => resolve_(null)); req.end();
    });
    let health;
    for (let n = 0; n < 30; n++) {
      health = await get(adminPort, "/healthz");
      if (health !== null) break;
      await new Promise(r => setTimeout(r, 250));
    }
    if (health !== 200) failures.push(`${image}: admin health is ${health}, expected 200`);
    if (await get(adminPort, "/readyz") !== 503) failures.push(`${image}: unconfigured gateway reported ready`);
    for (const path of ["/healthz", "/readyz", "/metrics"]) {
      if (await get(publicPort, path) !== 404) failures.push(`${image}: admin path ${path} exposed publicly`);
    }
    const stop = docker(["stop", "--time", "10", container]);
    const exit = docker(["inspect", "--format", "{{.State.ExitCode}}", container]);
    if (stop.status !== 0 || exit.stdout.trim() !== "0") failures.push(`${image}: SIGTERM did not exit cleanly`);
  } finally { docker(["rm", "-f", container]); }
  return failures;
}

// ---------------------------------------------------------------------------
// Self-test: every rule above, watched failing.
// ---------------------------------------------------------------------------

const MUTATIONS = [
  [
    "gateway dropped from image matrices",
    (root) => {
      const workflow = read(root, workflowPath);
      writeFileSync(resolve(root, workflowPath), workflow.replaceAll(
        "bin: [f2z-relay, f2z-kt, f2z-witness, f2z-ai]",
        "bin: [f2z-relay, f2z-kt, f2z-witness]"));
    },
    /f2z-ai is not in the build matrix/,
  ],
  [
    "published gateway digest no longer runtime-tested",
    (root) => {
      const workflow = read(root, workflowPath);
      writeFileSync(resolve(root, workflowPath), workflow.replace(
        'node scripts/check-f2z-images.mjs --probe-ai "$IMAGE_REPOSITORY@$IMAGE_DIGEST"',
        'echo skipped gateway probe'));
    },
    /workflow: missing node scripts\/check-f2z-images.mjs --probe-ai/,
  ],
  [
    "a paths: filter that no longer selects the crate sources",
    (root) => {
      const workflow = read(root, workflowPath);
      writeFileSync(
        resolve(root, workflowPath),
        workflow.replaceAll("      - rs/**\n", "      - rs/Cargo.toml\n"),
      );
    },
    /paths: filter does not select rs\/crates\/f2z-relay\/src\/main\.rs/,
  ],
  [
    "a paths: filter widened to everything",
    (root) => {
      const workflow = read(root, workflowPath);
      writeFileSync(
        resolve(root, workflowPath),
        workflow.replaceAll("      - rs/**\n", "      - rs/**\n      - '**'\n"),
      );
    },
    /paths: filter selects wallet\/zuuli\/src\/App\.tsx/,
  ],
  [
    "an unreviewed second architecture",
    (root) => {
      const workflow = read(root, workflowPath);
      writeFileSync(
        resolve(root, workflowPath),
        workflow.replaceAll("platforms: linux/amd64", "platforms: linux/amd64,linux/arm64"),
      );
    },
    /linux\/amd64 is the reviewed platform for the target cluster/,
  ],
  [
    "an action reference that lost its 40-hex pin",
    (root) => {
      const workflow = read(root, workflowPath);
      writeFileSync(
        resolve(root, workflowPath),
        workflow.replace(REVIEWED_ACTION_PINS[0], "actions/checkout@v7"),
      );
    },
    /action is not commit-pinned to a 40-hex sha/,
  ],
  [
    "a pinned action that lost its human-readable version comment",
    (root) => {
      const workflow = read(root, workflowPath);
      writeFileSync(
        resolve(root, workflowPath),
        workflow.replaceAll(REVIEWED_ACTION_PINS[4], REVIEWED_ACTION_PINS[4].split(" #")[0]),
      );
    },
    /has no trailing "# vX\.Y\.Z" comment/,
  ],
  [
    "a publish that stopped emitting an SBOM",
    (root) => {
      const workflow = read(root, workflowPath);
      writeFileSync(resolve(root, workflowPath), workflow.replace("sbom: true", "sbom: false"));
    },
    /workflow: missing sbom: true/,
  ],
  [
    "an attestation that is no longer pushed to the registry",
    (root) => {
      const workflow = read(root, workflowPath);
      writeFileSync(
        resolve(root, workflowPath),
        workflow.replace("push-to-registry: true", "push-to-registry: false"),
      );
    },
    /workflow: missing push-to-registry: true/,
  ],
  [
    "a `:latest` tag",
    (root) => {
      const workflow = read(root, workflowPath);
      writeFileSync(
        resolve(root, workflowPath),
        workflow.replace(
          "            ${{ env.IMAGE_NAMESPACE }}/${{ matrix.bin }}:main-${{ github.sha }}",
          "            ${{ env.IMAGE_NAMESPACE }}/${{ matrix.bin }}:latest",
        ),
      );
    },
    /`:latest` tag is a way to deploy something nobody chose/,
  ],
  [
    "a binary dropped from the build matrix",
    (root) => {
      const workflow = read(root, workflowPath);
      writeFileSync(
        resolve(root, workflowPath),
        workflow.replaceAll(
          "bin: [f2z-relay, f2z-kt, f2z-witness, f2z-ai]",
          "bin: [f2z-relay, f2z-kt]",
        ),
      );
    },
    /f2z-witness is not in the build matrix/,
  ],
  [
    "the Rust channel restated in the workflow",
    (root) => {
      const channel = read(root, toolchainPath).match(/^channel = "([^"]+)"$/m)[1];
      const workflow = read(root, workflowPath);
      writeFileSync(
        resolve(root, workflowPath),
        workflow.replace(
          "          version=$(scripts/check-rust-toolchain.sh --print-channel)",
          `          version=${channel}`,
        ),
      );
    },
    /workflow: restates the Rust channel/,
  ],
  [
    "a runtime base that lost its digest pin",
    (root) => {
      const dockerfile = read(root, dockerfilePath);
      writeFileSync(
        resolve(root, dockerfilePath),
        dockerfile.replace(/gcr\.io\/distroless\/cc-debian12:nonroot@sha256:[0-9a-f]{64}/, RUNTIME_BASE),
      );
    },
    /base image is not digest-pinned/,
  ],
  [
    "a runtime that went back to root",
    (root) => {
      const dockerfile = read(root, dockerfilePath);
      writeFileSync(
        resolve(root, dockerfilePath),
        dockerfile.replace(`USER ${NONROOT_UID}:${NONROOT_UID}`, "USER root"),
      );
    },
    /forbidden root user/,
  ],
  [
    "a cargo build that lost --locked",
    (root) => {
      const dockerfile = read(root, dockerfilePath);
      writeFileSync(
        resolve(root, dockerfilePath),
        dockerfile.replace("cargo build --locked --release", "cargo build --release"),
      );
    },
    /forbidden unlocked cargo build/,
  ],
  [
    "an entrypoint that no longer matches the deployment's exec probe",
    (root) => {
      const dockerfile = read(root, dockerfilePath);
      writeFileSync(
        resolve(root, dockerfilePath),
        dockerfile.replace(
          'ENTRYPOINT ["/f2z-witness"]',
          'ENTRYPOINT ["/usr/local/bin/f2z-witness"]',
        ),
      );
    },
    /bin-f2z-witness must ENTRYPOINT \["\/f2z-witness"\]/,
  ],
  [
    "the Rust channel restated in the Dockerfile",
    (root) => {
      const channel = read(root, toolchainPath).match(/^channel = "([^"]+)"$/m)[1];
      const dockerfile = read(root, dockerfilePath);
      writeFileSync(
        resolve(root, dockerfilePath),
        dockerfile.replace(
          'rustup toolchain install "$RUST_CHANNEL"',
          `rustup toolchain install ${channel}`,
        ),
      );
    },
    /Dockerfile: restates the Rust channel/,
  ],
  [
    "a builder that drifted off bookworm",
    (root) => {
      const dockerfile = read(root, dockerfilePath);
      writeFileSync(
        resolve(root, dockerfilePath),
        dockerfile.replace("rust:1-slim-bookworm@sha256:", "rust:1-slim-trixie@sha256:"),
      );
    },
    /builder base must be docker\.io\/library\/rust:1-slim-bookworm/,
  ],
  [
    "the workflow left unregistered as ungated",
    (root) => {
      const registry = read(root, gateRegistryPath);
      writeFileSync(
        resolve(root, gateRegistryPath),
        registry.replaceAll(workflowPath, ".github/workflows/absent.yml"),
      );
    },
    /is not registered in UNGATED_WORKFLOWS/,
  ],
  [
    "a toolchain restatement that drifted from the source of truth",
    (root) => {
      const restatement = read(root, workspaceToolchainPath);
      writeFileSync(
        resolve(root, workspaceToolchainPath),
        restatement.replace(/^channel = "[^"]+"$/m, 'channel = "1.0.0"'),
      );
    },
    /restates 1\.0\.0, not /,
  ],
  [
    "a build context that ships a developer's target directory",
    (root) => {
      writeFileSync(resolve(root, dockerignorePath), "# nothing excluded\n");
    },
    /must exclude target\//,
  ],
];

function copyTree() {
  const root = mkdtempSync(resolve(tmpdir(), "check-f2z-images-"));
  const files = [
    dockerfilePath,
    dockerignorePath,
    workflowPath,
    toolchainPath,
    workspaceToolchainPath,
    denyPath,
    gateRegistryPath,
    readmePath,
    ...SERVER_BINARIES.map((bin) => `rs/crates/${bin}/Cargo.toml`),
  ];
  for (const path of files) {
    const destination = resolve(root, path);
    spawnSync("mkdir", ["-p", dirname(destination)]);
    cpSync(resolve(repoRoot, path), destination);
  }
  return root;
}

function selfTest() {
  const failures = [];

  // The positive control. Without it every mutation below could be "failing"
  // because the fixture never validated in the first place.
  const clean = copyTree();
  try {
    const cleanFailures = validate(clean);
    if (cleanFailures.length) {
      failures.push(
        `self-test: the unmutated repository must pass, got:\n  ${cleanFailures.join("\n  ")}`,
      );
    }
  } finally {
    rmSync(clean, { recursive: true, force: true });
  }

  for (const [label, mutate, expected] of MUTATIONS) {
    const root = copyTree();
    try {
      mutate(root);
      const reported = validate(root);
      if (!reported.some((failure) => expected.test(failure))) {
        failures.push(
          `self-test: ${label} was accepted; expected a failure matching ${expected}, got ` +
            (reported.length ? `\n  ${reported.join("\n  ")}` : "no failures at all"),
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  return failures;
}

function report(failures, success) {
  if (failures.length) {
    for (const failure of failures) process.stderr.write(`${failure}\n`);
    process.exit(1);
  }
  process.stdout.write(`${success}\n`);
}

const [mode, ...rest] = process.argv.slice(2);
switch (mode) {
  case undefined:
    report(validate(repoRoot), "f2z server image supply chain: policy holds.");
    break;
  case "--self-test":
    report(
      selfTest(),
      `f2z server image policy self-test: ${MUTATIONS.length} mutation(s) rejected, clean tree accepted.`,
    );
    break;
  case "--inspect": {
    const [image, bin] = rest;
    if (!image || !SERVER_BINARIES.includes(bin)) {
      process.stderr.write("usage: check-f2z-images.mjs --inspect IMAGE BIN\n");
      process.exit(2);
    }
    report(inspectImage(image, bin), `${image}: distroless, uid ${NONROOT_UID}, runs /${bin}.`);
    break;
  }
  case "--probe": {
    const [image] = rest;
    if (!image) {
      process.stderr.write("usage: check-f2z-images.mjs --probe IMAGE\n");
      process.exit(2);
    }
    report(probeWitness(image), `${image}: the f2z-witness exec probes work.`);
    break;
  }
  case "--probe-ai": {
    const [image] = rest;
    if (!image) throw new Error("--probe-ai requires IMAGE");
    report(await probeAi(image), `${image}: gateway runtime probe passed.`);
    break;
  }
  case "--probe-relay": {
    const [image] = rest;
    if (!image) {
      process.stderr.write("usage: check-f2z-images.mjs --probe-relay IMAGE\n");
      process.exit(2);
    }
    report(await probeRelay(image), `${image}: a Kubernetes probe can reach /healthz.`);
    break;
  }
  default:
    process.stderr.write(
      "usage: check-f2z-images.mjs " +
        "[--self-test | --inspect IMAGE BIN | --probe IMAGE | --probe-relay IMAGE | --probe-ai IMAGE]\n",
    );
    process.exit(2);
}
