# ZUULI wallet Tor transport — #787

Status: implementation with Linux fixture and real Tor read evidence; **signed
Android/iOS acceptance OPEN**. Refs #787. This is not system-wide Tor or a
protection claim for Free2Z / E2E2Z. Nym remains a separate open decision (#789).

## Threat model and traffic inventory

ZUULI is the seed-holding wallet authority after #904. `src/App.tsx` mounts
Home, Wallet (including funding/authentication), About and Login. It mounts no
article/media, livestream or messaging view. Authentication identifies the user
to Free2Z even over Tor; Tor cannot undo prior requests, transactions, browser
handoffs or linkage to an account. An observer can recognize Tor use. Global
traffic correlation, compromised endpoints/OS/WebView, a malicious local proxy,
wallet protocol fingerprints and timing/amount correlation remain outside this
transport's protection. No key/custody material moves to another application.

| Traffic | Actual ZUULI runtime | Tor enabled policy |
| --- | --- | --- |
| Wallet/lightwalletd | `tauri-plugin-zcash/src/wallet/client.rs`; creation/account birthdays, proposals, sync streams and subtree/transaction queries, broadcast/rebroadcast/status/recovery | **Covered** native tonic channel, TLS for HTTPS endpoints, SOCKS5 hostname forwarding; all callers share this connector. Sync endpoint rotation retains its original epoch. Existing endpoint authority is unchanged. |
| Free2Z API | Frontend `lib/api/http.ts` → app `network::api_request`; account/balance/auth/funding | **Refused before client creation/DNS.** Direct mode retains scoped native HTTPS API calls; no inherited proxy environment, redirects or reusable idle pool. This includes native development builds, which cannot use Vite's direct proxy as a bypass. |
| Media | Browser CSP permits bundled/data images only; no remote media view | Unsupported/absent. No inference from native proxy settings. Free2Z's media is a different process and is **not covered**. |
| Livestreaming/WebRTC/SDKs | No mounted livestream view; CSP forbids remote media and frames | Unsupported/absent; no UDP/WebRTC protection. Free2Z's SDK traffic is **not covered**. |
| Messaging | No messaging UI/IPC grants; native enrollment and intent-v2 publication still use the engine, directory, witness and relay paths | **Refused** enrollment/publication in Tor mode. The wallet's receive poll takes direct-only leases. Transitions drain operations and close retained relay sockets/lock the engine. E2E2Z's independent receive loop is **not covered**. |
| Sapling parameter download | `wallet/send.rs::ensure_sapling_params` | Already-installed parameters remain usable; missing parameters cannot download in Tor mode. The blocking download owns a direct-only lease to completion. |
| External navigation | OAuth, Stripe, feedback and intent reply links | Native opener grants removed; app `network_open` and native bridge replies require direct-only leases. Launches are refused in Tor mode. An external browser/mail app launched previously is independent and cannot be stopped/protected by ZUULI. |
| Browser network / plugin bypass | Packaged CSP `connect-src 'self'`, no HTTP plugin command registration, no HTTP/opener grants | Remote fetch/WebSocket/image/media/frame connections are refused, rather than presumed proxied. Browser builds cannot enable Tor. Development/HMR browser traffic is not a release protection claim. |
| Inbound/control | Verified App Links, local OAuth loopback listener, local IPC | Inbound/local only. No Tor control protocol, external process launch, remote opt-in, arbitrary proxy URL, control-port authentication or claimed circuit isolation. |

## Runtime contract

`wallet/zuuli-transport` owns one process policy shared by ZUULI and its native
plugins. It is independent of custody and cryptography. Sibling executables
start with their own direct default; they cannot inherit ZUULI's preference.

The user supplies an **independently managed Tor SOCKS5 service on
127.0.0.1:9050**. ZUULI does not bundle, discover, own, start, restart, signal or
kill this service. It makes no control-port connection and cannot measure Tor
bootstrap percentage or authenticate that listener as Tor. A generic/malicious
SOCKS proxy on that port is not Tor. The operator must establish the service's
identity/configuration; a SOCKS success is labeled **proxy connected, Tor
identity unverified**. There is no OS/global proxy environment authority. No
proxy or destination is obtained from remote privacy configuration.

Example operator-owned C Tor configuration (not an installer):

```text
SocksPort 127.0.0.1:9050
SafeSocks 1
TestSocks 1
```

Its data directory, secure installation, updates and background availability are
the operator's responsibility. Tor may make directory/guard/relay connections;
those are Tor's own network protocol, not direct lightwalletd/DNS fallback by
ZUULI. No per-wallet/user SOCKS isolation credentials are presently configured.

Every connection captures the policy epoch before construction, including tonic
reconnects. Tor mode supplies the hostname directly to `tokio-socks`, rather
than resolving and forwarding an IP. HTTPS still uses rustls certificate/host
verification. There is no direct branch after a SOCKS, bootstrap, TLS or timeout
failure. An existing sync task cannot rotate endpoints into a newer epoch.

Transitions suspend first, close registered sockets with `shutdown(Both)`, take
the exclusive transition barrier, drain direct operations/connectors, disconnect
the messaging engine, durably replace the local preference, then publish the
new mode. A lifecycle/network event captured during draining invalidates the
acknowledgement and keeps clients suspended until an explicit reconnect. Stream
polls check the epoch under the same mutex used for revocation;
old channels cannot be resurrected by enable-disable-enable. Blocking directory
workers retain leases even if an async waiter is cancelled. OS resolver leases
live in the resolver job, so a request timeout cannot leave untracked DNS after
an acknowledgement. The directory's synchronous resolver avoids ureq's detached
timeout DNS threads. Slow OS DNS may delay a transition; it cannot allow it to
report enabled early. API cancellation may discard a result but the native
request drains under its lease before a transition can acknowledge.

The local `tor-mode` preference is read before network work is admitted. Missing
means direct default; malformed/unreadable existing state fails toward Tor.
Startup initially suspends all clients. A failed settings write leaves networking
suspended and reports failure; there is no successful mode acknowledgement.
Preferences are local only. The implementation is not an OS firewall: additions
to the outbound inventory must use this policy or be explicitly refused.

## Native WebView navigation boundary

`connect-src` alone does **not** restrict top-level navigation. ZUULI creates
exactly one `main` WebView through `navigation::create_main`; automatic config
creation is disabled. Its native `on_navigation` and `on_new_window` hooks are
installed before loading a document. Popups, including local/blank popups that
could later retarget, are denied on desktop. An app-wide navigation plugin also
refuses remote navigation on attached WebViews. Renderer WebView/window creation
commands carry explicit deny permissions, so a renderer cannot build an
unguarded second view.

The URL decision admits only `tauri://localhost` on Linux/macOS/iOS or
`http://tauri.localhost` on Windows/Android with the pinned default scheme.
Credentials, nondefault ports, lookalike hosts, remote/custom/data/blob/file URLs
and other platforms' aliases are refused. The only development exception is
`http://127.0.0.1:1423`, and only when built in Tauri development mode. Local
paths, query strings, fragments and native IPC remain available.

On Linux, WebKit can speculate DNS/TCP for an anchor **before** delivering a
navigation decision. DNS-prefetch settings alone did not stop that behavior in
the live fixture. The factory therefore starts with a denied empty document,
then installs a native WebsiteDataManager network refusal policy **before**
loading any application HTML. Unsupported WebView HTTP(S) traffic is directed
to the literal loopback refusal endpoint `http://127.0.0.1:0`; there is no proxy
server or forwarder, destination DNS resolution or direct fallback. Port zero
cannot be bound as a fixed listening service. Only the exact development
`127.0.0.1:1423` endpoint is exempted in development builds. This is **not Tor
proxying or proxy identity verification**: browser networking is unsupported and
refused. Native wallet RPCs still use the separate working Tor transport.

The mobile popup defaults were inspected in pinned Wry 0.55.1: Android does not
enable multiple-window support, so popup intents use the main navigation path;
iOS does not implement popup creation. Signed-device validation remains open.
Android's `shouldOverrideUrlLoading` does not cover POST submissions, so the
packaged CSP additionally sets `form-action 'none'`; forms must use native API
commands. This supplements the native boundary and does not replace it.
Native speculative-network hardening is exercised on Linux only; other native
platform acceptance is still open and no cross-platform protection is inferred.

Primary API/source references: pinned Tauri 2.11.5 `on_navigation`,
`on_new_window`, manager navigation dispatch and Wry platform implementations;
[WebKit network proxy settings](https://webkitgtk.org/reference/webkit2gtk/2.41.6/ctor.NetworkProxySettings.new.html),
[Android WebViewClient](https://developer.android.com/reference/android/webkit/WebViewClient),
and [Android multiple-window settings](https://developer.android.com/reference/android/webkit/WebSettings#setSupportMultipleWindows(boolean)).

## State and lifecycle

About contains the opt-in action and concise state. Advanced details explain the
external service, unverified identity, platform limits and epoch, without URLs,
wallet identifiers, credentials or traffic payloads.

- **Direct**: the default, no Tor claim.
- **Waiting**: Tor routing selected; the next wallet request must use SOCKS.
  External Tor may still be bootstrapping; ZUULI does not invent a percentage.
- **Proxy connected**: a SOCKS destination connection succeeded, not Tor identity
  or continuous internet reachability verification.
- **Degraded**: connection failed/timed out; no direct fallback.
- **Suspended**: native focus loss, Android pause/iOS resign-active, mobile
  resume, WebView background, or observed offline/online event revoked sockets.
  Resume requires explicit Reconnect; it never silently selects direct mode.

A physical network change that does not produce a platform/WebView event can
leave a Tor socket pending until failure, still addressed only to the local
proxy. It cannot switch to direct networking. Reconnect starts a new epoch;
users may also need to restart wallet sync, whose old epoch stays invalid.

## Integration choice and primary references

Researched before using the APIs on 2026-11-12:

- [Tor SOCKS extensions](https://spec.torproject.org/socks-extensions.html):
  SOCKS5 domain-name targets avoid client-side destination DNS; no UDP support.
- [Arti client API](https://docs.rs/arti-client/latest/arti_client/): native
  asynchronous Tor streams are an alternative. This change chooses external
  C Tor SOCKS rather than introducing an embedded Arti runtime/cache/update and
  mobile packaging dependency into the wallet graph. No Arti support is claimed.
- [tokio-socks 0.5.3](https://docs.rs/tokio-socks/0.5.3/tokio_socks/tcp/socks5/struct.Socks5Stream.html):
  reviewed installed source and tuple-domain encoding, `connect`/`into_inner`.
- [tonic connector](https://docs.rs/tonic/0.14.9/tonic/transport/struct.Endpoint.html):
  reviewed installed `connect_with_connector`, TokioIo and explicit TLS config.
- Installed reqwest DNS `Resolve` and ureq 3.4 `Resolver`/`Agent::with_parts`
  source define the direct-only resolver hooks. These are not Tor paths.

The reviewed librustzcash gitlink also contains `zcash_client_backend::tor`
(`tor.rs`, `tor/grpc.rs`, `tor/http.rs`), behind its **disabled** `tor` feature.
Those helpers use Arti 0.35 and provide bootstrap, isolated clients, dormancy
and network deadlines. They are not mounted ZUULI traffic coverage and do not
revoke this app's other clients/WebView authority. They were inspected; this
change does not enable or claim them, update that graph, or import unpublished
upstream work. The external SOCKS choice avoids introducing an embedded Tor
runtime and its platform packaging into the wallet graph. The native connector
retains 30s connection / 60s response-header deadlines and 30s/20s active-stream
HTTP2 keepalive detection, without capping legitimate streaming response bodies.

## Coordination with Nym #789

Nym is **not implemented, enabled, evaluated as protective or performance
measured** here. The common decision is a single native policy/epoch boundary,
explicit per-traffic coverage, no browser/SDK inference, and no direct fallback.
A future Nym proposal must supply its own supported transport/runtime,
resolution policy, platform lifecycle and battery/latency evidence, mutually
exclusive mode transition semantics and a fresh inventory of sibling apps.
It cannot reuse the label “Tor” or assume this SOCKS fixture proves mixnet
protection. This document supplies the Tor side of #789's comparison only.

## Acceptance and reproducible evidence

All fixtures are local, without funds or store/provider purchases. Tests use the
same `Policy::channel` that the shipping lightwalletd helper calls, not a parallel
dummy transport. `tests/native_policy.rs` exercises TCP/SOCKS/HTTP2, hostname
encoding, reachable destination traps, proxy failure, existing direct/old-Tor
channels, queued connection epochs, cancelled blocking workers, suspension and
explicit resume. The namespace script uses a live local DNS server and a real
TCP destination; it changes neither the host resolver nor external DNS.

```sh
cargo +1.97.1 test --locked --manifest-path wallet/zuuli-transport/Cargo.toml
wallet/zuuli-transport/scripts/tor-leak-fixture.sh
```

The isolated DNS test reported Tor-mode DNS=0/TCP=0; direct negative control
DNS=2/TCP=1. A separately launched C Tor **0.4.9.11**, with SafeSocks and TestSocks,
bootstrapped 100%; the explicit ignored benign `public_tor_tls_read_probe`
returned HTTP 200 / gRPC status 0 from `GetLightdInfo` at `zec.rocks:443` through
Tor. It loaded no wallet and sent no transaction. This proves a real read path
on this Linux host, not proxy identity verification by the shipped app, mobile
availability, anonymity against correlation, or a completed send.

Local detailed logs are retained in `.evidence/787/`; final validation and limits
are recorded in `VALIDATION.md`. Runtime test services must be stopped before
handoff. The external public probe is opt-in and never part of ordinary CI.

- [x] Real opt-in native wallet transport and state; concise UI, advanced limits.
- [x] Automated remote-name/TCP/fallback/epoch/lifecycle fixture evidence.
- [x] Local controlled DNS and direct-network negative controls.
- [x] Real Tor/TLS/HTTP2/gRPC read on Linux.
- [x] Explicit unsupported Free2Z/media/streaming/messaging/app boundaries.
- [ ] Signed Android device: trusted Tor runtime availability, background,
  pause/resume, lock/unlock, Wi-Fi→cellular, process death/cold start, proxy
  restart, loss/timeout, disable/re-enable and forced no-fallback with captured
  DNS/TCP counters. Record app/build/device/OS/runtime versions and timestamps.
- [ ] Signed iOS device: same transitions with a supported available Tor runtime;
  establish an actual platform integration before claiming support. No bundled
  runtime currently exists. Capture latency/reliability/battery over foreground
  and suspended intervals. Simulated callbacks are not device acceptance.
- [ ] Native macOS/Windows builds and platform runtime evidence via required CI;
  Linux alone does not prove every target.

Do not close #787 or advertise mobile Tor protection until device acceptance
exists. No emulator/synthetic event is recorded as a physical device result.
