# Changelog

## Unreleased — 0.1.0 source example

- Add a package-consuming browser app and reusable Tauri frontend with ordinary
  public OAuth configuration. This is not a native host or device test harness.
- Show exact bigint balance/debt and receipt states; preflight strict requests,
  journal keys before paid work, and support cancellation and explicit
  same-account/same-body/same-key recovery without an automatic fresh-key retry.
- Open Free2Z billing (Zcash first, card second) only by build opt-in; keep
  Manage separate and omit purchase commands/scopes.
- Fence asynchronous status, receipt, balance and stream delivery against both
  the current operation epoch and the actual session subject/generation. Late
  cancellation/sign-out cannot overwrite a newer session or stop its stream;
  external native session replacement clears stale account data before publication.
- Add deferred regressions for late cancellation success/failure, sign-out
  overlapping new authentication, and replacement before/during post-call balance
  reads, including a generation change for the same subject.
- Test recovery, storage refusal, expired keys and account fencing against the
  installed SDK. Build both frontend modes and check the real guest API types.

No registry release or live acceptance is claimed. The 0.4.0 npm dependencies
still require publication; local tarball validation does not prove availability.
