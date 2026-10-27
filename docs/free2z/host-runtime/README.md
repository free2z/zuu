# Native host runtime

Free2Z host applications use a relocatable CPython runtime and the canonical
`rs/zcash-payment-hooks` daemon. The package is derived from the exact backend
image selected by a signed website release. Deployment configuration, receiving
identities, service definitions, wallet paths, secrets, and activation controls
belong to the deployment repository.

The preparation protocol does not authorize activation. A consumer must verify
both releases independently, match their source commit and backend digest,
check its observed platform, and assemble an inactive candidate. Before service
activation, the deployment controller must separately prove its UID, inherited
producer-lock descriptors, wallet/WAL mounts, timeouts, process cleanup, source
guards, and readiness behavior. Packaging qualification cannot prove a live
service's configuration.

## Package construction

The build job reads a verified Linux amd64 backend image export without
extracting arbitrary archive paths. Image links resolve inside that image;
cycles and paths escaping its root fail. The CPython interpreter, standard
library, installed application dependencies, application source, certificates,
cached tokenizer data, and license files are copied into a new tree. A virtual
environment is not a supported input.

The daemon must be compiled from the same ZUU commit with the repository's
locked Rust toolchain and Cargo lockfile, inside the selected backend image.
The tool archive checksums in `build/free2z/host-tools.json` are build inputs.
No compiler, dependency installation, or package download runs on the receiving
host. Rust dependency license files and their package inventory accompany the
binary.

The packager parses ELF program headers and dynamic strings without running
the loader or `ldd`. It copies every declared non-glibc dependency from the
image. Conflicting library names, unresolved dependencies, unsupported search
paths, and requirements newer than glibc 2.36 fail. Every native object receives
its own relative `DT_RUNPATH`; an executable's `RUNPATH` alone does not resolve
an extension's transitive dependencies. Derivation evidence records source and
patched hashes, dependency edges, and build input identities.

Psycopg 3's Python implementation locates `libpq` through system discovery
rather than `DT_NEEDED`. One byte-pinned relocation changes that resolver to
the bundled `runtime/lib/libpq.so.5`; missing files and symlinks fail. Its exact
upstream input hash and transformed output hash are recorded. A dependency
update requires reviewing that relocation again. Qualification requires an OS
loader cache with no `libpq` entry and verifies the selected bundle path; no
`LD_LIBRARY_PATH` or system-library fallback is supplied.

The receiving host supplies only the glibc 2.36 ABI and its loader. The explicit
library names are `ld-linux-x86-64.so.2`, `libc.so.6`, `libdl.so.2`, `libm.so.6`,
`libpthread.so.0`, `libresolv.so.2`, and `librt.so.1`. This is not an arbitrary Linux portability
claim. Libraries loaded dynamically by application code require qualification
coverage as well as static dependency inspection.

Host admission must observe `/etc/nsswitch.conf` and installed name-service
providers. The qualified profile uses only `files dns` for host lookup.
Additional modules such as systemd or SSS require an explicitly reviewed
matching profile or rejection before activation. Qualification performs a
synthetic `/etc/hosts` lookup with networking disabled; it cannot establish the
receiving host's live DNS or NSS behavior without that host observation.

## Qualification

`scripts/free2z/host-runtime-qualify.py` runs under the bundled interpreter with
`-I`, an empty starting environment, a read-only payload, a non-root receiving
UID, and no network. The qualification container must not contain the source
image, another Python installation, credentials, or real wallet data. Invoke it
at two unrelated absolute payload prefixes to exercise relocation.

It checks Python's resolved prefix and import paths, `pip check`, Django's
application registry, application/native imports, the bundled certificate
store, and loaded native mappings. It executes the daemon's help command,
proves a flock survives direct Python exec with the receiving UID, checks
SIGTERM delivery/reaping, and reads a synthetic SQLite WAL database through a
read-only connection. These checks exercise the bundled interpreter and
libraries; they do not replace the daemon's lifecycle tests or the deployment
controller's activation rehearsal.

The archive is deterministic USTAR with only regular files, sorted paths,
zero ownership/timestamps, and modes `0444` or `0555`. It contains no links,
host configuration, deployment entrypoint, or environment secrets. Every file
is inventoried by path, SHA-256 digest, size, and mode.

## Preparation manifest, version 2

The manifest has exactly these top-level fields:

| Field | Contract |
| --- | --- |
| `schema_version` | Integer `2` |
| `protocol` | `free2z-host-preparation-v2` |
| `source` | `repository: free2z/zuu`, exact 40-character `commit` |
| `build` | `workflow: .github/workflows/free2z-host-release.yml`, decimal-string `run_id`, integer `run_attempt` |
| `web_release` | `release_id` hashes the retained website manifest bytes; `backend_digest` identifies its exact backend OCI manifest |
| `platform` | Linux, Debian 12, x86_64, glibc 2.36, loader path and explicit system-library allowlist |
| `runtime` | Bundled CPython implementation/version/SOABI and `evidence: runtime/derivation.json` |
| `archive` | `name: host-runtime.tar`, SHA-256, byte size, and SHA-256 of `host-files.json` |

The host's system Python is not part of `platform`. A host with Python 3.11 can
execute a qualified bundle carrying CPython 3.12 because the bundle supplies
that interpreter and its dependencies. Consumers must reject unknown fields
and protocols rather than inferring compatibility from a version string.

The release producer requires a successful signed website release from the
same commit as its trusted protected-main workflow. The preparation build has
read-only permissions. A separate publishing job may attest and upload the
opaque archive and manifest; it must never execute the artifact, application,
or a dependency installer. A manual producer does not establish an automatic
release path: automatic promotion requires independent event-provenance checks
and a consumer that verifies them.

To prepare a candidate, select a successful `free2z-web-<commit>-<run>-<attempt>`
release whose commit is the current protected `main`, then dispatch
`free2z-host-release.yml` on `main` with that tag as `web_release_tag`. A source
mismatch fails before image use. The host release publishes the manifest,
archive, inventory, separate attestation bundles, and the retained website
evidence as `website-*` assets. The Actions artifact preserves the website
evidence under `web-release/`.

Publication creates a draft, uploads and checks every asset's server-reported
digest, then publishes the complete release. A failed upload leaves an
unpublished draft. To retry a failed publishing job, choose **Re-run all jobs**
or start a new dispatch. A publish-only retry is rejected because its attempt
number no longer matches the qualified build; it cannot relabel an earlier
artifact with a new invocation identity.

The build requires at least 14 GiB of free scratch disk. Rust compilation and
tests run with two CPUs, a 6 GiB memory limit, bounded process counts, a
read-only source/image filesystem, and writable scratch directories. Downloaded
tools are checksum-verified before use. The build container can fetch locked
public Cargo dependencies; qualification containers have no network.

Run the data-only regression suite without Docker or downloads:

```sh
python3 -m unittest discover -s scripts/free2z/tests -p test_host_runtime.py -v
```

This suite verifies rejection behavior and deterministic packaging. Only a
successful Linux qualification run establishes native runtime compatibility.
