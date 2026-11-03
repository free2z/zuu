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
