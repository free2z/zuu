# Local campaign proof of concept

`/projects/campaign-demo` starts with a blank local post. It reuses the ordinary
Free2Z title field, editor preview, MarkdownContent and article table of contents.
The ordinary Publish button opens the existing PublishSheet. Its optional
campaign section follows the single Zcash wallet field; confirming publishes only
in this browser. The writer keeps the title, description and body, and the reader
keeps one support block inside the normal reading column. Closing the sheet
preserves drafts and receipt witnesses. The sheet uses the existing 250-character
description limit; older local drafts up to 500 characters remain intact and
editable until the creator shortens the description before publication. The existing `/edit` publication, upload and account
APIs are untouched. There are no wallet scans, transfers, backend writes or real
campaign publications.

The editor/creator laboratory stores fictitious receipt totals and a private salt
in `free2z-local-campaign-v2`. These are test data, not an authenticated ledger.
A separate `free2z-local-campaign-v2-reader` record contains only the public
ReaderDocument. Opening `?reader=1` loads that record without reading creator
storage. Rejected creator storage remains untouched until an explicit new-post or
publish action, and autosave validates a draft before replacing a valid record.
It can verify proofs after the creator record is removed. This local
prototype has no authentication: creator and reader modes demonstrate different
payloads and views, not browser-local access control.

## Proof statement

The pinned Circom 2.2.2 circuit constrains a private unsigned 64-bit total of
fictitious zatoshis and a 248-bit random salt. It derives the public comparison
bit `total >= threshold`, with the threshold independently constrained to 64
bits. Both true and false outcomes require valid PLONK proofs. A missing,
malformed, stale or invalid proof gives an unknown status.

`Poseidon(total, salt, context)` commits to the same private total for every
phase. `context` is SHA-256 of an explicit protocol domain, canonical complete
post/campaign configuration, campaign identity and receipt snapshot nonce,
reduced to the BN254 scalar field. The circuit also derives
`Poseidon(context, threshold, phaseIndex)`. All three public inputs enter
constraints; the phase is bounded to 3 bits and the application permits at most
five phases. Public signals have a fixed ordering:

1. Receipt commitment
2. Comparison bit
3. Phase binding
4. Threshold in zatoshis
5. Campaign/configuration/snapshot context
6. Phase index

The verifier rebuilds the expected context and threshold from the already
published local ReaderDocument, checks phase identity, snapshot and the COMMON
expected commitment, validates canonical bounded proof coordinates/scalars, then
calls the real snarkjs PLONK verifier with the application’s fixed key. Imported
proofs cannot choose a replacement key or expected publication. Exports omit the
receipt total, salt and witness. Decimal parsing and all funding decisions use
BigInt zatoshis, rather than floating point.

Every receipt changes its nonce and salt and invalidates prior proofs. Async
operations are versioned so an edit/republication cannot install a late result.
Spending changes the available balance, never the cumulative received amount or
its funding proofs. Benefit delivery remains separately reported by the creator.
Republication starts a new fictitious receipt snapshot and clears deliveries.

## Setup and reproducibility

Versions are pinned in package-lock.json: snarkjs 0.7.6, circom2 0.2.22 (compiler
2.2.2), circomlib 2.0.5. The source is
`circuits/campaign-threshold.circom`.

### Proving assets are built, not committed

The browser proving assets (`threshold.wasm`, about 1.8 MB, and
`threshold.zkey`, about 9.1 MB) are a deterministic function of the pinned
circuit, the pinned compiler/library versions and the public transcript, so
they are not checked in. `scripts/campaign-proof-assets.mjs` runs as part of
`prebuild` and `pretest` (or directly as `npm run campaign:proof-assets`). It
downloads the transcript from the manifest's `source`, checks its BLAKE2b-512,
checks the circuit's SHA-256, compiles the circuit, derives the PLONK key and
installs the two files into `static/projects/campaign-demo-proof/` only if each
matches the SHA-256 recorded in the bundled manifest. Any mismatch is a hard
failure. Files that are already present and match are reused without a
download. For an offline build, point `CAMPAIGN_PTAU_FILE` at a local copy of
the transcript; it is hash-checked the same way. This path does not repeat the
full MPC transcript verification below; that one-time audit is what produced
the manifest.

### Re-deriving the manifest

To re-derive keys after changing the circuit or a pinned tool, from the
frontend root:

```sh
npm ci
npm run campaign:proof-generate
node --test tests/campaign-demo.test.mjs tests/campaign-proof.test.mjs
```

Review and commit the resulting `manifest.json` and `verification-key.json`
changes (in both `static/projects/campaign-demo-proof/` and
`src/lib/campaign/artifacts/`).

The generator downloads the public Hermez Powers of Tau power-12 MPC transcript,
checks its official BLAKE2b-512 hash, runs the full snarkjs 0.7.6 Powers of Tau
source verifier, compiles the circuit and derives its PLONK key. It NEVER creates a local ceremony or a
known setup secret. The original ceremony has 54 contributions plus a beacon;
its original power-28 challenge hash requires approximately 96 GiB of repeated
input even for this truncated file. Measured JavaScript BLAKE2b throughput was
about 30 MB/s, which can make reconstruction take roughly an hour on a typical
development machine. `scripts/verify-campaign-mpc.mjs` accelerates ONLY
`calculateFirstChallengeHash` by replacing its BLAKE2b-512 provider with Node’s
native BLAKE2b-512. It does this in an isolated copy of the hash-pinned upstream
utility, never by editing installed package files. The rest of the official
verifier, including all ceremony, beacon, powers and pairing checks, is unchanged.
Before verifying, complete native/upstream initial-hash self-tests must match
at powers 4, 8 and 12. The full adapted verification passed in **174 seconds**
on the original author's machine. This is disclosed as a native initial-hash adapter, not an
unaltered CLI run. The redundant slow unmodified run was stopped only after the
complete equivalent check succeeded.

The exact URL, hash, tool versions, circuit
SHA-256 and fixed WASM/zkey/verifier-key hashes are in the committed manifest.
The public transcript and the WASM/zkey derived from it are build-time inputs,
not runtime downloads or committed files. Browser WASM/zkey assets load from the same origin and are
SHA-256 checked before proving from the reserved
`/projects/campaign-demo-proof/` namespace; the verifier key is bundled and fixed. Routine
unit tests check the source/artifact hashes and exercise actual proofs; they do
not reconstruct the MPC ceremony.

The proof system inherits the public ceremony’s trust assumption (at least one
honest participant and correct transcript/circuit/compiler). The circuit and its
integration have not received a specialist cryptographic audit. PLONK here
proves a relation to a LOCAL FICTITIOUS commitment. It authenticates neither
Zcash receipts nor address ownership nor an on-chain balance. Zcash shielded
transaction privacy alone does not establish this fundraising statement.

Primary references: [snarkjs setup and browser guidance](https://github.com/iden3/snarkjs),
[bounded comparators](https://github.com/iden3/circomlib/blob/master/circuits/comparators.circom),
[bit constraints](https://github.com/iden3/circomlib/blob/master/circuits/bitify.circom),
[Zcash viewing-key specification](https://zips.z.cash/zip-0316).

## Local validation observations

The browser generated and verified three actual phase proofs after adding
12.5 fictitious ZEC in **19.8 seconds** in the local development preview.
Chromium reported approximately **212 MB of JS heap** (a coarse bucketed reading,
not total process memory). The proof assets are approximately **1.8 MB WASM +
9.1 MB zkey + 2.1 KB verifier key**. They load from the same origin; repeat
proving reuses verified asset bytes. An independent reader verified with its
creator storage record removed and did not show the private amount. The reader
layout stayed within 390 px and 320 px viewports. The real-proof Node security
test covered true/false outcomes and tamper/context/range negatives in roughly
9 seconds. Timings depend on hardware and concurrent work.
