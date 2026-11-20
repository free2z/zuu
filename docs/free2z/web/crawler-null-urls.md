# Free2Z website: relative null URL investigation

Refs #1324. Production attribution and the fresh operator observation window
remain **OPEN**. Synthetic local tests cannot establish that crawler discoveries
are external or stale, and do not support closing the issue.

## Observation access and scope

On 2026-11-13, the available connected tools included no observability connector
for this deployment. Read-only local CLI inspection found an expired AWS session,
no signed-in Azure account, and no Google Cloud application-default or Kubernetes
configuration. Neither `gcloud` nor `kubectl` was installed. Usable access was
unavailable, so no production traffic query was performed; no traffic counts,
request timestamps, exact operator crawler UA,
or referring pages were obtained. No operator was contacted and no production
visitor data was copied. The historic crawler-class/count comment in
[`zpage-slug.ts`](../../../ts/svelte/free2z/src/lib/zpage-slug.ts) is not a fresh observation.

The source base is `b4e3d79334b6ee56f0796776db6251e821d5dd4a`. The
implementation commit is `34950dc3b301211811d8d8a88f7e48b04758b29d`. The aggregate
evidence hashes its changed code/config/test files; documentation follows in a
separate commit without changing the tested implementation. No production rendering or route-rejection change is
included. The completed reserved-vanity sitemap work is separate and is not
evidence explaining these requests.

## Reproduction and coverage

From `ts/svelte/free2z`, install the locked dependencies with `npm ci`, then run:

```sh
npm run test:browser -- crawler-null-urls
```

The existing Playwright configuration owns the mock API and Vite server, derives
non-conflicting loopback ports, and stops both after the run. This is a finite
fixture test, not a crawler. Each of four synthetic public views runs with four
optional-data states, first with JavaScript disabled (browser-parsed SSR markup)
and then with hydration enabled: 16 comparisons / 32 application renders.

| View | Synthetic route | State and interaction coverage |
| --- | --- | --- |
| Homepage | `/` | SSR mobile feed, cards, absent/present featured image and creator images; scroll and hover preload |
| Profile | `/null-url-fixture` | Avatar/banner missing, empty URL fields, JSON null, present media; optional display name; bio, share menu, card hover |
| Article | `/null-url-fixture/null-url-article` | Featured image/byline media variants, optional `get_url`, SSR markdown, mounted heading enhancement, image and consent-gated embed, scroll |
| Conversation | `/converse/null-url-conversation` | Author avatar variants, absent/empty/null/present `content_url`, SSR root, delayed client reply, reply composer |

Required identities (creator username, article identifier, thread UUID) remain
present; unsupported null author objects are not used. A synthetic expired
session bypasses the anonymous homepage cache and resolves to anonymous user
data. The no-session branch is also exercised by the existing SSR suites; these
fixtures do not cover real signed-in accounts, private content or production data.

The controlled UA uses the published
[Googlebot Smartphone template](https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers),
read 2026-11-13, with a fixed test Chrome version:

```text
Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)
```

This is test configuration, not a captured UA or a claim about the crawler in
#1324. Contexts use 390 × 844, touch/mobile emulation and reduced motion. The
article waits for mounted heading enhancement, every hydrated view waits for
session resolution, and conversation replies arrive after a controlled delay.
The final scan follows interactions and a one-second observation interval.

[`null-url-audit.ts`](../../../ts/svelte/free2z/tests/browser/null-url-audit.ts) resolves candidates
through the browser URL parser and compares their origin/path to the document
directory plus `null`, ignoring query and fragment values. It inspects `href`,
`src`, `srcset`, preload `imagesrcset`, `poster`, form actions, object/embed URLs,
inline/style-sheet/computed CSS URLs, social URL metadata and URL-bearing JSON-LD
properties. A pre-script MutationObserver retains transient attribute values
and tracks streaming insertion, hydration and delayed renders. Context request
events count all resource types, navigations and worker HTTP requests; worker
creation is counted separately. Counts in the URL inventory are scan operations,
not distinct URLs or visitors.

Controls prove that a transient `href="null"`, `src="null"`, srcset, poster,
action, object, preload, CSS and JSON-LD URL are detected, as are actual image,
fetch, worker fetch and navigation requests. Prose `null`, JSON null, an ordinary
JSON script, valid `?q=null`/`#null`, another origin and `null.png` are controls
that do not match. A separate CLI control server proves delayed bad URLs produce
a nonzero result and missing configuration sends zero requests.

## Explicit operator reproduction

[`probe-null-urls.mjs`](../../../ts/svelte/free2z/scripts/probe-null-urls.mjs) is an optional bounded
probe using the same detector. Read its installed help first:

```sh
node scripts/probe-null-urls.mjs --help
```

Supply the operator UA through `FREE2Z_PROBE_USER_AGENT`, exactly four explicit
public paths in homepage/profile/article/conversation order, and a private JSON
readiness file with four entries in the same order. Each entry has a `selector`
for a unique visible client-introduced result and an optional `trigger` selector for a
native non-submit button. The result must be absent from the independent no-JS
SSR render. A static SSR marker cannot prove client execution.

The checked-in [Free2Z readiness configuration](../../../ts/svelte/free2z/tests/browser/null-probe-readiness.json)
uses the mobile navigation button and newly mounted menu on homepage, profile
and conversation views; the article uses a mounted heading permalink. The four
application fixture tests exercise these criteria in addition to their existing
session, article-enhancement and delayed-reply markers. An article without a
heading needs a different appropriate criterion, such as its functional menu.
A readiness criterion proves that selected boundary, not every component or timer.

For an authorized public deployment, replace all placeholders explicitly:

```sh
FREE2Z_PROBE_USER_AGENT='<operator UA kept private>' \
  node scripts/probe-null-urls.mjs --origin https://PUBLIC-ORIGIN.example \
  --path / --path /PUBLIC-PROFILE --path /PUBLIC-PROFILE/PUBLIC-ARTICLE \
  --path /converse/PUBLIC-THREAD --readiness-file /private/signals.json \
  --public-read-only
```

Readiness waits at most 15 seconds by default; `--readiness-timeout-ms` accepts
100–15000 ms. Inert/stalled clients and already-present SSR results produce
`client-incomplete` records and a nonzero exit, while the SSR scan remains
independent. Successful client records say `client-ready-scrolled` and report the
criterion kind, observed status and SSR absence, without exposing selectors.
After readiness, the probe scrolls and observes for three seconds. Clicking a
button before its handler is bound can yield an incomplete result; it is never
accepted as evidence that the client emitted no bad URL.

The probe makes eight bounded renders and never discovers or follows links.
HTTP interception permits only GET/HEAD, capped at 200 requests per render
externally or 1000 on loopback, with a 45-second maximum per render. It requires
installed WebSocket routing before any page is visited; routed sockets never
connect to the server. Pre-script document/frame guards deny available
WebSocket/WebSocketStream, WebTransport, WebRTC, dedicated/shared workers,
EventSource and beacon APIs; service-worker registration is denied and the
context also blocks service workers. These transports/worker realms are
unsupported by this standalone probe. Any attempted use, unsupported guard,
popup, blocked HTTP request, page error, non-200 response, unresolved readiness
or incomplete render makes the run nonzero. This also means a Vite page that
attempts its HMR socket cannot be reported as a successful standalone probe.
The general local application audit retains its separate worker-request control.

The [CLI controls](../../../ts/svelte/free2z/tests/browser/null-url-probe.spec.ts)
start only synthetic loopback fixtures. An unguarded browser first sends an
actual message to a built-in Node WebSocket endpoint. The guarded CLI must then
send zero connections/frames, report denied transports and exit nonzero. Other
available transport attempts, inert/stalled/static 200 pages, a working client
button reaction, delayed null URL and missing configuration are also exercised.
Run these bounded controls with:

```sh
npm run test:browser -- null-url-probe
```

The CLI retains no browser profiles, traces, HTML, screenshots or raw network
logs. JSON contains UTC probe times, software versions, a validated build SHA
when provided, HTTP counts, blocked transport categories, readiness status and
URL-source categories. It omits URLs, paths, page text, UA, selectors and
exception details. It does not start servers or schedule future runs.

## Limits and next evidence

Local Vite + mock API execution does not test deployed ingress/CDN behavior,
the classic React UI, or Django crawler-prerender output. The Django crawler
module/templates and SvelteKit URL/media normalizers were inspected; their
comments referencing older deployment routing are not proof of the current
production tier. The existing Python crawler suites require Django/PostgreSQL;
this environment has no pytest installation or running Docker daemon, so they
were not run. There are no backend changes in this diff.

Cross-origin stylesheet rules cannot be read through CSSOM; their network
requests remain observable. Snapshot CSS checks do not retain every transient
CSSOM-only update. Closed shadow roots, browser internals, all possible delayed
timers/interactions, and query-embedded proxy destinations are not exhaustively
covered. The standalone transport policy is for ordinary public application
behavior on the installed Chromium, not a security sandbox against hostile
code deliberately escaping instrumentation. Transport attempts make coverage
incomplete rather than providing a successful read-only result. A match identifies
a candidate/request boundary, not its author or the
cause of a production visit. A zero result means only that the tested state
did not emit that boundary during that interval.

The next operator evidence must specify a fresh finite UTC window, deployment
version and aggregate counts grouped by path shape and crawler class, including
the directory-relative-null shape and relevant response statuses. Keep raw
visitor IPs, referrers, user IDs and tokens private. The exact UA and public
reproduction targets can be applied privately to the opt-in probe. Compare a
probe of the deployed version with those aggregates before attributing the
requests or considering closure.

## Validation record

Local tool versions: Node 24.18.1, npm 11.16.0, Playwright 1.64.0 and bundled
Chromium headless shell 156.0.8078.4 (revision 1248). Focused Node route/SSR/social-card
suites: 69 passed, including the no-backend-call invalid-route controls.

The corrected focused browser command was:

```sh
npm run test:browser -- crawler-null-urls null-url-probe --max-failures=2 --reporter=list,json
```

The corrected application fixture window was **2026-11-13 13:55:03.589–13:57:53.282
UTC**. All 16 comparisons / 32 application renders reported zero directory-null
URL candidates and zero matching HTTP requests. All **22 focused tests passed**
(17 application/detector tests and five CLI-control tests), including the
transport policy, meaningful client readiness, delayed-bad-URL and zero-request
configuration controls. The unguarded socket control sent one actual message;
the guarded CLI sent zero WebSocket connections/frames and zero beacon POSTs,
worker-script or EventSource requests. Both transport probe runs exited 1.
Inert, stalled and static-SSR cases each retained four independent SSR scans
and rejected all four client renders as incomplete. A working client button
reaction completed four client renders and exited 0. These are local fixture observations, not an operator
traffic window. The
[aggregate evidence](crawler-null-urls-evidence.json) retains the configuration,
request-type counts, URL-source check counts, mutation records and worker counts.

Before the transport/readiness correction, the broader browser command was:

```sh
npm run test:browser -- crawler-null-urls ssr-article-body legacy-route-redirects live-route-ssr --max-failures=3 --reporter=list,json
```

That historical run completed with **49 passed / 2 failed** (18 new tests passed; 31 existing tests
passed). The two existing failures were `legacy-route-redirects.spec.ts`'s
`/begin and /begin/alt permanently move to the sign-up modal` (dialog absent
after five seconds), and `live-route-ssr.spec.ts`'s `the hydrated preview never
boots the viewer` (auth state still `unknown` instead of `anonymous` after five
seconds). An earlier broader run also timed out waiting for the anonymous
profile login modal; that case passed in the historical 49/2 run. No login/stream routes
or their tests were changed. These failures are recorded rather than claiming
the broader suite is green or asserting a production cause.

An isolated diagnostic run reproduced both failures with the new crawler
specs excluded and the new mock fixture never enabled:

```sh
npm run test:browser -- legacy-route-redirects live-route-ssr --grep '/begin and|hydrated preview never' --max-failures=2
```

It reported two failures with the same five-second assertions (and an additional
runner error summary on stopping at the failure cap). Their cause remains
unresolved; this run is not a separate pristine-base checkout comparison.

`npm run check`: zero errors, 27 warnings. `npm run lint` and final focused
ESLint/Prettier checks passed. `npm run build` completed with the Node adapter.
Namespace and Markdown-link guards, including
their self-tests, passed. Code/config/test hashes bind the recorded observations
to the implementation; the documentation commit follows without changing code.

All owned browser contexts, fixture servers and development servers were stopped
after validation. No production changes were published.
