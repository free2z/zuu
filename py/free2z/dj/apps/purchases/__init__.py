"""Purchase intents: how an app (or the web wallet) buys 2Z (PU1).

The contract is zuu ``docs/free2z/sdk/spec/purchase.md``; the design is
Pillar 2. A ``PurchaseIntent`` is created by ``POST /api/sdk/v1/purchases``
and polled by ``GET /api/sdk/v1/purchases/{id}`` until it is ``credited``.
The rail does the paying and the platform does the crediting: on the card
rail the credit is still posted by the existing, exactly-once Stripe
fulfilment (``dj.apps.ztripe.fulfillment``), which now also links a
``PurchaseReceipt`` and moves the intent to ``credited``
(:func:`dj.apps.purchases.services.record_card_fulfillment`).

Card only in this app's first release. Zcash per-intent addresses (Z1), the
in-app purchase rails (first-party only) and Stripe refund/dispute webhooks
(the post-credit states) are later PRs; the status vocabulary and the state
machine already carry their states so those PRs add edges' callers, not a
migration of the state set.
"""
