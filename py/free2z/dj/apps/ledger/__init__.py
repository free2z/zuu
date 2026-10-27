"""The 2Z double-entry ledger (Pillar 2; design: docs/tuzis/ledger-v2.md).

2Z are **platform credits**. Nothing here is money, currency or crypto.

This app is self-contained so it can move to another repository later. Other
apps call the public functions in:mod:`dj.apps.ledger.api`; nothing here
imports another ``dj.apps`` package, and the one foreign table the SQL
touches (``g12f_creator``, the balance projection during dual-write) is named
by its table, exactly as the design says. Migration L1 (``0001_initial``)
creates the ``ledger`` schema, the tables and the SQL functions. **Nothing in
the product calls any of it yet** (design §10 step 1); the dual-write release
is the next step and a separate PR.
"""
