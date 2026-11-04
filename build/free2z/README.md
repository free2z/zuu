# Free2Z website builds

The website release contains three independently addressed images built from one
Zuu commit: Django and its workers (`free2z-backend`), SvelteKit (`free2z-web`),
and nginx with classic UI, documentation, Django static files and bridge assets
(`free2z-static`). Application builds need no deployment repository or credentials.

## Local development

From the repository root:

```sh
docker compose -f build/free2z/compose.yml up --build
```

Open http://localhost:8080. The disposable PostgreSQL and Redis services are
accessible only on the Compose network. Migrations complete before the backend
and workers start. Django HTTP and ASGI services serve the API and WebSockets;
nginx serves documentation and admin static assets from the static image.
Application containers target linux/amd64, including under local emulation. The database persists in the project's named volume. The
sample credentials are local fixtures, unsuitable for a public deployment.
Provider-backed features require separately configured test accounts; the sample
environment supplies no paid-provider credentials and disables card checkout.

```sh
docker compose -f build/free2z/compose.yml run --rm backend /py/dj/free2z/manage.py createsuperuser
docker compose -f build/free2z/compose.yml down
```

For a separate development instance, use a different Compose project name and
adjust the localhost port and canonical origin together. Explicitly remove the
named database volume only when its local data is no longer needed.

## Release contract

The `Free2Z website gate` requires backend, migration, schema/client, frontend,
browser, documentation, dependency and packaged-runtime checks. Unrelated wallet
changes skip the application jobs through an explicit checked selector.

The website release workflow runs this gate on protected `main`, builds and
checks images without publishing credentials, and passes image archives to
separate publisher jobs. Publishers do not install dependencies, rebuild images,
or execute application containers. All image subjects receive provenance and
SPDX SBOM attestations. Anonymous registry access must succeed before a release
is eligible for deployment.

Syft 1.38.0 catalogs each immutable local Docker image ID. Its Linux/amd64
release archive is verified against SHA-256
`bc664debb00db1b9b4b9dae4ba1a29d99621e33b641b94b78b9048374b812a3d`,
from the [official release checksums](https://github.com/anchore/syft/releases/download/v1.38.0/syft_1.38.0_checksums.txt).
The installer downloads from allowlisted HTTPS origins with a byte limit and
writes only the verified regular executable into a new directory. It executes
no downloaded installer and uses no shared tool cache or repository Syft config.
The read-only build
job validates its SPDX 2.3 package/file profile, shortens only document-local
identifiers and their references, and checks that reversing this mapping
reconstructs the complete original JSON. Package, file, checksum, license and
relationship evidence is retained. Unsupported structures, dangling references
or a normalized predicate larger than the attestation action's 16 MiB limit
fail the build before publication. This profile check is not a general SPDX
schema validator.

The image artifact retains the original inventory, normalized predicate and a
receipt binding the predicate's SHA-256 to the inspected Docker configuration
ID. The publisher verifies this receipt against the loaded image before pushing,
then attests the complete predicate against the returned registry manifest
digest. Syft's source manifest checksum is preserved: archive and registry
manifest representations may differ, and neither is the Docker configuration ID.

The public GitHub release tag is
`free2z-web-<source commit>-<workflow run id>-<attempt>`. Its
`free2z-release.zip` contains exactly:

- `release.json`: schema version 1, source commit, workflow/run identity, the
  three image repository/digest pairs, the browser asset inventory hash, and
  the registered and scheduled task names verified against the initialized worker.
- `static-assets.json`: sorted browser asset paths and SHA-256 content hashes.
- `release.intoto.jsonl`: the manifest's Sigstore provenance bundle.

`APP_RELEASE_ID` is `sha256:` followed by the SHA-256 of the exact `release.json`
bytes. Deployment consumers verify the successful source run, expected protected
branch and workflow, manifest bundle, image attestations and image digests.
Each image digest identifies a single linux/amd64 manifest. The manifest's
`task_registry` has schema version 1 and sorted, unique `registered` and
`scheduled` arrays. Registered names are nonempty; scheduled names must be a
subset. Each list contains at most 1,024 ASCII task names of at most 256
characters, and the complete release manifest is limited to 64 KiB. The
secretless backend check exports this inventory only after its static scan
matches both the live worker registration and scheduling registries. Deployment
consumers compare new schedules with the verified registrations of every
running worker release before rollout.

Tags and asset names identify candidates; they do not establish trust.

Keep the image packages public and retain published digests and release evidence.
Consumers persist the selected evidence and image attestations alongside their
deployment history before applying changes, so rollback does not depend on
short-lived GitHub Actions artifacts. Actions archives are additional evidence,
not the durable distribution interface. Re-run the whole release workflow after
a failure; each attempt builds and signs its own coherent artifact set.

## Runtime configuration

Native host preparation qualifies the bundled interpreter and payment daemon
at two extraction paths in an isolated Debian 12 container. Its
[`host-nsswitch.conf`](host-nsswitch.conf) explicitly selects glibc's built-in
file lookups for every known name-service database, with DNS also available for
hostnames. Read-only fixture account files exercise user, group and supplementary
group lookups; an empty cache directory excludes the nscd socket. Signed
qualification reports bind the exact profile hash and record these checks.
The synthetic hostname lookup uses the container's hosts file; it does not
establish live DNS connectivity. Deployment admission must independently verify
the receiving process's name-service configuration, cache isolation and account
identity. Qualification does not authorize changing a host's account services.

The backend keeps `PYTHONPATH=/py`, Django's `dj.*` imports and
`/py/dj/free2z/manage.py`. Its explicit runtime module allowlist excludes test-only
settings. The web container serves `/app/build`; its client assets are under
`/app/build/client`. Static content preserves `/base/build`, `/base/docsbuild`,
`/base/dj/free2z/static` and `/base/bridge-pages`.

Operators provide nginx routing configuration and domain-association documents
through mounts. Images contain no organization secrets or private infrastructure
configuration. Source identity is baked into `BUILD_SHA` / `PUBLIC_BUILD_SHA`;
operators set `DEPLOYMENT_SHA` and `APP_RELEASE_ID` for the selected deployment.

## Migration bootstrap

The CI foundation permits the exact fingerprinted historical public Python
scaffold while the full application snapshot is being introduced. A changed or
partial scaffold fails; introducing the complete backend enables all application
checks; removing its production lock fails. The release publisher refuses the
scaffold. Remove this bootstrap exception after the ownership cutover.
