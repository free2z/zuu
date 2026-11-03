# Free2Z PPV admission rollout

Paid PPV admission retries require an idempotency key bound to the viewer and
the provider session. The Svelte client obtains the current session identity
from live status, persists a key only for that session, and clears it after
RealtimeKit confirms `roomJoined`. A cancelled join attempt unregisters its
listener and retains the key so a retry cannot create a second admission.

Legacy cached clients that do not send `admission_idempotency_key` are refused
with HTTP 400 (`admission_idempotency_key_required`) before any PPV admission
is prepared or provider participant is created. This is an intentional rollout
limitation: those clients must refresh to a compatible bundle before joining
paid PPV. Their old owner/viewer-only browser key is not adopted because it
cannot distinguish a replaced provider session safely.

The rollout also has a reverse compatibility boundary. A new Svelte bundle
requires the provider `session_id` in live status and stops before the join
request when an older backend omits it. Deploying only the backend first makes
cached clients refuse paid joins; deploying only the client first makes the
new bundle refuse paid joins against the old backend. There is no safe
keyless bridge: synthesizing a server key for an old client would prevent
duplicate provider POSTs, but would also make every later join in that same
provider session unresolved. RealtimeKit Add Participant does not provide a
documented idempotency or token-recovery mechanism to distinguish a completed
first POST from a lost response. Deploy the client and backend as one
coordinated release (or keep the paid join unavailable during a staged
rollout); do not add a fallback that retries with a fresh key or silently
reuses an unscoped legacy key.

After an admission exists, repeating the same key is deliberately unresolved:
`prepare_livestream_admission` raises
`livestream_provider_outcome_unknown`. The endpoint must return before calling
`DyteClient.add_participant` again. The viewer needs support/reconciliation;
the request path must not interpret a timeout as proof that the provider did
not create the participant.
