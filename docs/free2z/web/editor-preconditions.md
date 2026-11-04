# Free2Z editor conflict recovery (#1271)

The editor preserves all editable fields in session storage under the loaded
account ID, article UUID and content language. The offered reload first verifies
that the current snapshot was written. If storage is blocked or full, reload is
cancelled and the edits stay in memory. Recovery is tab-local, not a server
backup. After reload the editor shows the server version and offers Restore
draft or Discard draft. Restoring applies the rejected fields against that
freshly loaded version; the next save remains conditional. Successful saves clear
the recovery copy when no newer edits arrived during the request. Invalid
stored data is ignored rather than applied.

Only 404 means a requested variant is absent. Other failed or invalid reads
block editing and expose Reload; auth failures retain the login return path.
New translations still use `If-None-Match: *`.

Tag decisions accept optional `If-Match`, checked under the article row lock,
and return the new quoted `ETag`. Optional `lang` selects the variant whose
validator is supplied and returned; omitting it selects the canonical article.
Variant validators cover canonical metadata as well as translated prose.
Decisions and saves in one editor are serialized. Stale decisions change neither
tags nor suggestion status. Existing API consumers can still omit preconditions.

## Follow-up measurement and required-header policy

No production logs or credentials were available for this implementation.
There is no measured production conflict rate in this change. Local test
conflicts and historical prose elsewhere are not current frequency evidence.

An operator should measure aggregate 412 responses divided by write attempts
for canonical writes, variant writes and tag decisions over a representative
window, for example 14 days. Also measure the fraction carrying preconditions
and distinguish create-only conflicts from stale updates where existing
aggregate telemetry permits. Use route families and client release only; do not
record account/article IDs, request URLs, ETag values, draft text, cookies or
credentials. This change adds no telemetry. If existing telemetry cannot answer
these questions, record that limitation and agree on aggregate counters first.

Keep preconditions optional pending that evidence. A required-header rollout
needs measured header adoption, supported-client and third-party migration
coverage, a published compatibility policy and explicit approval. Low 412 counts
alone cannot establish adoption: unconditional writes never fail a stale
precondition check.
