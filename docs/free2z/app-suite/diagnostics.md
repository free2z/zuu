# Free2Z app-suite diagnostics — issue #980

The three frontends use `wallet/shared/src/diagnostics`: at most 40 failures,
24 live breadcrumbs, 12 breadcrumbs per failure, and 48,000 persisted characters.
Free text is shape-filtered before storage; this cannot distinguish ordinary
message prose from ordinary error prose. Never interpolate user content into
errors. `Error.cause` remains deliberately ignored, including nested native
errors. No diagnostic export automatically uploads anything.

## Native transport and privacy boundary

`rs/crates/f2z-diagnostics` is a std-only workspace member consumed by the three
shipping Tauri roots. The hook installs at process entry with a bounded memory ring; setup attaches the app's fixed private app-data file
`native-diagnostics-v1.log`. The process hook replaces (and drops) the previous
hook rather than chaining it: the default hook would print the unredacted panic
payload to stderr. Payloads and filenames are never read or formatted. Records
contain only `native-panic`, epoch seconds, line and column. This intentionally
provides less evidence than retaining a source filename.

The mutex protects records and the open file together. Panic capture and
report reads use try-lock: contention/reentrancy drops evidence instead of waiting on an unwinding
thread. At most 40 fixed numeric records fit under 4,096 bytes; restart reads
are bounded and reject malformed/oversized files. Writes truncate the same file
before replacing the ring, so interruption can lose records but cannot grow a
log. I/O failure does not stop the app or leave the payload-printing default hook active; the memory ring remains usable. No fsync/durable-crash guarantee is made;
an abort, storage failure, a panic before storage attaches, or a later hook replacement can
leave no evidence. The hook runs on Rust unwind panics, not arbitrary native
crashes or platform process termination.

ZUULI and e2e2z expose only an argument-free `native_diagnostics_report` command
against managed state. It accepts no path or caller text. As with their existing
app commands, Tauri's plugin capability ACL does not gate it. These apps render
no remote content. No capability entry, event or initialization script was
added. Frontend readback independently checks the closed numeric grammar and
size/count bounds before rendering or copying.

Free2Z has **no native renderer readback**. It still has no invoke handler.
Neither events nor initialization scripts can safely target only our frame under
#367; none was added. The diagnostics route, including the report copied or
shared there, states explicitly that it contains frontend records only. Its
native file is local instrumentation, not an available in-app native report.
This is the transport asymmetry explicitly accepted by #980. It does not grant
a hostile remote frame access to native diagnostics.

## Views and feedback tiers

Free2Z has `/diagnostics`, desktop navigation and an always available header
link for phones. ZUULI shows diagnostics next to Feedback on About. Both use the
shipping en/fr/es i18n kernel. e2e2z's existing diagnostics panel now reads native
records when opened. Native records persist across restart; clear actions clear
only frontend records and say so. Readback is unavailable in browser previews or
when hook installation/managed readback fails. If file attachment fails, native
readback contains only the current process's bounded memory records. Copy/share contain the displayed report, including
safe bundle frames in frontend events. Users should inspect it before sharing.

ZUULI's optional feedback attachment is a separate, reduced rendering of the
production store: failure kinds and counts only. No names, error messages,
frames, filenames, native records or causes enter that attachment. The switch
starts off and the preview can remove the attachment. Tests run the independent
`scrubFeedbackText` oracle unchanged and require zero findings; the full report
is a negative control that produces findings.

Navigation records only enter/leave codes in each router (e2e2z has one screen).
Messaging status/device reads, enrollment attempts/outcomes, and the Free2Z tip
and e2e2z enrollment intent consumers record closed codes, never route strings,
handles, amounts, request IDs, response bytes or plaintext.

## Smaller follow-ons and evidence limits

- `Error.cause`: deferred under #980's follow-on scope until a separate closed
  schema is reviewed. It is not silently expanded by this implementation.
- Source guard: the required e2e2z Vitest suite checks Error constructors in
  the plaintext-owning messages UI with a TypeScript AST and refuses dynamic
  arguments. Positive/negative controls cover interpolation and member access.
  Whole-tree alias/data-flow enforcement (including Error subclasses and
  third-party producers) remains deferred under #980; this scoped guard does
  not prove absence of plaintext throughout the program. Existing enrollment
  error details and mock/i18n errors are outside that guard's scope.
- Capacity/quota: Free2Z Playwright fills real browser localStorage to a real
  QuotaExceededError, then drives 1,000 captures through the production store,
  checks count/serialized bounds, frees space and proves persistence recovers.
  The native test drives 800 caught panics across eight threads through the
  installed production hook and reopens the file, checks bounds, and rejects
  hostile/oversized persisted bytes. This is bounded local soak coverage, not
  a claim about every mobile filesystem or browser storage implementation.
