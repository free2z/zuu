"""Paid requests to start an end-to-end encrypted chat in e2e2z.

The public contract is in the zuu repo's epic, free2z/zuu#1022, as
"Contract A" (this API) and "Contract B" (the link the notification carries).
In short:

* ``GET  /api/e2ee/chat-requests/price/`` returns the server-set price.
* ``POST /api/e2ee/chat-requests/{username}/`` charges the sender that price,
  **credits it to the recipient** through the ordinary 2Z ledger
  (``dj.apps.tuzis.ledger.transfer``), and records an
  ``ENCRYPTED_CHAT_REQUEST`` event for the recipient. It is retry-safe through
  the same ``IdempotencyKey`` machinery as ``donate-idempotent``.

The event is what reaches the recipient: the feed, the unread badge and the
WebSocket push all come from the ``Event`` row, and the email is sent by
``e2ee.send_chat_request_email`` (``tasks.py``), which is deferred in the
same transaction as the charge.

Nothing here carries a message. The link only opens e2e2z's first-contact
screen with the sender's handle filled in; the chat itself never touches this
server.

Where a messaging handle comes from is answered in exactly one place,
``handles.resolve_messaging_handle``. Read its docstring before changing how
a handle is looked up.
"""
