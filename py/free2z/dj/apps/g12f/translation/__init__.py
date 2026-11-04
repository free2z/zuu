"""Paid AI translation of a zPage into another language ( Part 6).

Four modules, each with one job:

``safety``   what makes machine output safe to store next to creator content.
``service``  chunking, prompting, pricing and the provider call. No database.
``charges``  the money: claim, debit, refund, and the record that ties a
             charge to a delivery.
``tasks``    the Procrastinate worker that does the translating, plus the
             sweep that refunds a charge whose job never arrived.

The HTTP surface lives in ``dj.apps.g12f.views.translate``.
"""
