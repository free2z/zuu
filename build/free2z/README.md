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
