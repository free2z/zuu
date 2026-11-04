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

The background worker [recovery contract](../../docs/free2z/jobs/recovery.md)
describes lease fencing, conservative healing latency, and process exit after
a confirmed lease-thread stall.

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

## Job admission and poster backfills

Poster admission counts each owner's `todo`, `doing`, and `aborting` job
until terminal, even with a stale lease. Unlike the original early-release
proposal, this reserves the slot across recovery: requeueing an abandoned job
must not oversubscribe an owner after another job has filled its slot. The
upload and sweep paths use the cap; already queued work is not displaced.

Higher Procrastinate priorities are fetched first. Export cleanup uses
`RECOVERY`, between `INTERACTIVE` and `DEFAULT`, rather than `MAINTENANCE`:
expired archives and abandoned exports need timely cleanup, while interactive
requests retain precedence. Poster backfills use fixed `BACKFILL`, below all
other named classes. Priority cannot interrupt a running job, and sustained
higher-priority traffic can delay lower-priority work.

For poster bulk enqueue, inspect first and then choose a small slice:

```sh
python dj/free2z/manage.py backfill_video_posters --dry-run
python dj/free2z/manage.py backfill_video_posters --limit 50 --rate 40 --max-inflight 100
```

Enqueue requires `--limit` or `--all`, plus `--rate` (jobs per minute) and
`--max-inflight`. Priority is fixed by the command, not a command-line option.
The in-flight check counts nonterminal poster jobs before each serialized
batch; concurrent upload and sweep admissions can exceed that snapshot. The
backfill bypasses per-owner admission, so it can delay new work for those owners.

We accept scheduled pacing rather than add a runtime rate limiter for the
documented single-worker configuration: the repository's [compose example](../../build/free2z/compose.yml)
sets worker concurrency to one, the command limits its queued additions, and
the lower priority lets eligible live work be fetched first. Before enqueueing,
operators must verify the actual worker replica count and concurrency; the
example does not establish the current deployment configuration or protect an
external service's rate. `schedule_at` only sets a not-before time: after downtime overdue
jobs can start back-to-back, and neither the snapshot limit nor worker
concurrency guarantees a rate or protects an external service from bursts.
Operators should use smaller slices and a conservative in-flight limit when
that matters. Revisit runtime limiting if worker concurrency increases or a
strict downstream rate is required; priority also cannot preempt a long decode.

Language display names are generated by `scripts/free2z/gen-language-names.py`
from the repository root. Use a separate Python environment with the hash-locked
`py/free2z/requirements/language-data.txt`; the CLDR data and trie dependency do
not belong in the runtime image. Regeneration preserves the curated language
sets defined in `f2z/languages.py`.

See [Content languages](../../docs/free2z/web/languages.md) for registry changes,
translation evidence, catalog behavior and the limits derived from the offering.

From the repository root, `PYTHONPATH=py/free2z DJANGO_SETTINGS_MODULE=pytest_settings python scripts/free2z/economy-writer-register.py --write` refreshes the model and
writer source inventory using the installed locked backend dependencies. This
inventory identifies call sites requiring review; it is not financial approval
or evidence about a deployed service.

### Cantonese language repair (g12f 0122, #1284)

The storage inventory is `g12f_zpage.source_language`,
`g12f_zpage.detected_language` (the latest detector label),
`g12f_zpagetranslation.language` (legacy reads/dual writes), and
`g12f_zpagevariant.language` (source, human and AI variants). These four
columns are repaired together. `language_source` records provenance, not a
language tag. `g12f_zpagemutationactor.language` is immutable historical actor
evidence and stays verbatim, as do deletion/export snapshots, job payloads,
translation cache/quote state, idempotency hashes and financial history. A
`TranslationQuote` is an in-memory dataclass, not another language column.

The repair considers only bare `yue` and `yue-*` primary tags (case and edge
whitespace included) that the current registry accepts. For example `yue` and
`YUE` become `yue-Hant`, `yue-hant` becomes `yue-Hant`, and `yue-hans-cn`
becomes `yue-Hans-CN`. Already canonical `yue-Hans`, `yue-Hant-HK` and
`yue-Latn` remain unchanged; regions are not discarded or guessed. Invalid or
unknown labels, NULL, empty values and all other languages are untouched.

**Collision policy: abort, never choose a winner.** Before writing anything,
check each affected page for two variants or two legacy translations that
would have the same canonical language, and for a source/legacy-translation
collision even without a variant mirror. Also check the page source against
human/AI variants, even when both the source mirror and legacy translation
are missing: neither rewriting a bare source onto a canonical translation nor
rewriting a bare translation onto a canonical source is allowed. This includes
two different aliases mapping to one destination, not only an existing
`yue-Hant` destination. The
source and its source-variant mirror, and a translation and its variant mirror,
are intentionally allowed across tables. Only an `origin="source"` variant
may mirror the page source; a human/AI variant at that identity is distinct
content and blocks the repair whenever either label would change.
Pre-existing collisions unaffected by the repair are not reconciled. Errors identify page, model, row IDs and labels;
no content is printed. Owners must explicitly reconcile conflicting content
outside this migration; no row is silently merged, overwritten or deleted.

Deployment owners can run this read-only, repeatable preflight in their own
environment before applying migrations:

```sh
python dj/free2z/manage.py plan_yue_language_migration --database default
```

It uses a repeatable-read, read-only transaction, reports field counts by
old/new label, and exits unsuccessfully on collisions. It is advisory: actual
migration 0122 repeats preflight while holding PostgreSQL SHARE ROW EXCLUSIVE
locks on the three tables, blocking writers but permitting ordinary readers.
A three-second lock acquisition budget fails/retries rather than waiting
indefinitely. Plan a quiet deployment window and pause/drain writers and paid
translation jobs first: old in-flight payloads must not recreate aliases after
the repair. Apply via the normal `migrate` deployment step, rerun the preflight
(expect zero updates), and check both published variant URL spellings. Capture
counts, collision resolutions, deployment and URL-check evidence in the
operators' external deployment record; repository tests are not that evidence.
No cloud access or external execution is needed to implement this change.

Only language columns change, in one transaction. IDs, slugs/addresses, content,
publication/lifecycle dates, timestamps, model provenance, source digests,
paid balances, reservations, receipts and audit rows stay intact. Thus old
`/variants/yue/` links and canonical `/variants/yue-Hant/` links both resolve
through existing URL normalization after migration. Rerunning is a no-op.
Reversing the migration leaves canonical labels in place: there is no safe
way to infer which spelling an originally canonical row used.

### Dependency reconciliation (issue #1338)

The backend image uses Python 3.12; its runtime authority is `requirements/main.in`
plus the generated hash lock. `django-dbbackup` 5.4.0 and `google-cloud-pubsub`
2.43.0 were already present in both. This update moves PyAV 19.0.1 to 19.0.2,
certifi 2026.10.19 to 2026.10.23, OpenAI 3.29.0 to 3.38.0, and Autobahn
26.10.1 to 26.10.2; the constrained audit-tool lock follows certifi. PyAV's
[release](https://github.com/PyAV-Org/PyAV/releases/tag/v19.0.2) includes a
channel-layout double-free fix and a CPython 3.12 Linux wheel. Autobahn's
[changelog](https://github.com/crossbario/autobahn-python/blob/master/docs/changelog.rst)
identifies the peer-certificate fix for newer pyOpenSSL. OpenAI's
[release notes](https://github.com/openai/openai-python/releases/tag/v3.38.0)
record its SDK changes; provider streaming and usage must remain compatible for
OpenAI-compatible services, not just OpenAI. Certifi's [release](https://github.com/certifi/python-certifi/releases/tag/2026.10.23)
updates the trust bundle. The main lock and CI audit lock are regenerated with
the pinned lock tools; no other tracked requirements lock contains these pins.

The separate local media test server moves Flask 3.0.0 to 3.1.3 and Flask-CORS
4.0.0 to 6.0.0. Flask 3.1 drops Python 3.8; the backend contract is 3.12.
The server intentionally retains its all-origin CORS policy and loopback bind.
[Flask's release](https://github.com/pallets/flask/releases/tag/3.1.3) and
[Flask-CORS advisory](https://github.com/advisories/GHSA-8vgw-p6qm-5gr7)
describe fixes included by these versions.
