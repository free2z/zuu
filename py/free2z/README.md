# Free2Z backend

This directory contains the Django API, background workers, database migrations,
and supporting Python libraries for the Free2Z website. The application source
uses the `dj`, `f2z`, `gcp`, `twatter`, and `zcashrpc` Python namespaces.

Use Python 3.12. From this directory:

```sh
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install --require-hashes -r requirements/main.txt
python -m pip install --require-hashes -r requirements/test.txt
export PYTHONPATH="$PWD"
```

Regenerate a dependency lock from the repository root with
`scripts/free2z/compile-python-requirements-lock.sh main` or
`scripts/free2z/compile-python-requirements-lock.sh test`. The helper uses the
pinned Linux image and hash-verified compiler tools. Test dependencies are
constrained by the production lock. CI tool locks use the same helper with
`ci-audit`, `ci-lint`, or `ci-policy`. Each has a direct input constrained by the
production lock; these tools are installed in separate environments.

Website CI audits all seven Python locks and checks every applicable package
and version in the report. It separately installs compiler and language-data
tools with required artifact hashes. Tool installations use `--ignore-installed`
so packages supplied by virtual-environment bootstrap cannot bypass hash checks.
To verify a developer lock locally with Python 3.12, run
`python scripts/free2z/install-python-tool-lock.py lock-tools --verify-only`
from the repository root; `language-data` selects the CLDR tool environment.

The test suite uses PostgreSQL with the pgvector extension. Give each checkout
its own database and port, then set `DBHOST`, `DBPORT`, `DBNAME`, `DBUSER`, and
`DBPASS` for that disposable database. Run `python -m pytest` here. Test fixtures
replace external Pub/Sub calls; paid provider credentials are not required for
the ordinary application tests. Tests that exercise external binaries describe
their prerequisites beside the test.

The native payment-delivery tests combine the Rust journal and executable hooks
with the isolated PostgreSQL database. Install the repository's pinned Rust
toolchain and the crate's build prerequisites, precompile the harness, then run
these tests explicitly from this directory:

```sh
cargo test --locked --manifest-path ../../rs/zcash-payment-hooks/Cargo.toml --test financial_delivery --no-run
PAYMENTD_NATIVE_BRIDGE_TEST=1 python -m pytest dj/apps/g12f/test_paymentd_native_credit.py -q
```

The harness uses synthetic receiving events and test database state. It does not
scan a live wallet or establish production host custody or deployment evidence.

The website entrypoint is `dj/free2z/manage.py`; set
`DJANGO_SETTINGS_MODULE=dj.free2z.dev_settings` for local development. Run migrations
before starting the server:

```sh
python dj/free2z/manage.py migrate
python dj/free2z/manage.py runserver 127.0.0.1:8000
```

Web reauthentication is enabled per provider through
`SOCIAL_WEB_REAUTH_PROVIDERS`, a comma-separated list of `google`, `github`,
and `x`; `twitter` is accepted as an environment alias for `x`. The default is
empty. Register the exact first-party `/oauth/reauth-callback` URL with each
provider before enabling it. Native OAuth configuration alone does not establish
web callback readiness; the separate legacy-X login path is unchanged.

Production uses `dj.free2z.prod_settings`. It requires explicitly provisioned
credentials and signing keys; generated test keys are not production keys.
Deployment, infrastructure configuration, and secret provisioning are maintained
separately. Application images contain no production credentials.

`CHANNEL_REDIS_HOST` and `CHANNEL_REDIS_PORT` configure Redis; the development
defaults are localhost and 6379. `PROJECT_ID` and `GS_BUCKET_NAME` select optional
Google Cloud resources. `STATIC_ROOT` overrides the collected static-file
location for production builds. Keep these values in the deployment environment.

Payment host operations require separately supplied deployment configuration.
`FREE2Z_DEPLOYMENT_ROOT` selects an absolute directory containing the approved
host authority and guard under `zcash/pipeline`. The application compares that
guard with the installed root-managed guard before accepting financial events;
missing configuration refuses the operation. `NODE_HEALTH_SUPPORT_TABLE` and
`NODE_HEALTH_FLOOR_POLICY` select node-monitoring policy files. The
`guarded_release()` maintenance check expects the legacy host bundle layout
(`py/dj`, `py/zcashrpc`, and `zcash/pipeline`); a website image alone is not a
payment-host release bundle.

The API schema is `dj/free2z/openapi/f2z.yaml`. The Svelte website generates its
client from that file. `BUILD_SHA` identifies application source;
`DEPLOYMENT_SHA` and `APP_RELEASE_ID` identify deployment configuration and the
selected artifact set. `/api/healthz` exposes those three identities without
contacting a database or external service.

First-party source in this project is MIT licensed. Third-party data and code
retain the notices supplied with their files.

Language display names are generated by `scripts/free2z/gen-language-names.py`
from the repository root. Use a separate Python environment with the hash-locked
`py/free2z/requirements/language-data.txt`; the CLDR data and trie dependency do
not belong in the runtime image. Regeneration preserves the curated language
sets defined in `f2z/languages.py`.

From the repository root, `PYTHONPATH=py/free2z DJANGO_SETTINGS_MODULE=pytest_settings python scripts/free2z/economy-writer-register.py --write` refreshes the model and
writer source inventory using the installed locked backend dependencies. This
inventory identifies call sites requiring review; it is not financial approval
or evidence about a deployed service.
