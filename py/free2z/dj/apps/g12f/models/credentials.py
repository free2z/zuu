"""The account epoch a bearer token was minted against.

Why a stamp exists at all, and why deleting rows was not enough
--------------------------------------------------------------

``dj.apps.ktauth.epoch.bump_account_epoch`` deletes every Knox token the
account holds when an ownership event lands. That is an **enumerate-then-delete
sweep, and a sweep is a point in time, not a barrier.** Nothing serialises it
against token *issuance*, so a login that is already in flight — one that read
its ``SocialIdentity`` or ``ZcashIdentity`` before the sweep ran — inserts its
row *after* the sweep has finished and walks away with a live bearer credential
for a principal that was just evicted (; the codex adversarial review of
 rated it HIGH twice and named it the riskiest line in that diff).

Adding the racing row to a bigger sweep cannot fix it: the row does not exist
when the sweep enumerates. Re-reading the counter after the INSERT only narrows
the window, because two transactions that take no common lock have no ordering
to appeal to. **A generation checked at USE time is race-free by
construction**, which is what this table is:

* the issuer stamps the token with the epoch it read **in the same database
  snapshot that validated the credential** — for the social and Zcash paths a
  single ``select_related('creator')`` query, so "the identity exists" and
  "the account is at epoch N" cannot be answered from two different instants;
* authentication refuses any token whose stamp is not the account's current
  epoch (``dj.apps.ktauth.authentication``).

Then the two interleavings are both safe and neither needs a lock:

1. the event commits **after** the stamp is read — the stamp is stale by
   exactly one, and the token is refused the first time it is presented;
2. the event commits **before** the stamp is read — then it also committed
   before the identity read that shares its snapshot, so the identity is
   already gone and the login never reaches issuance.

The stamp is deliberately **not** a timestamp. A token minted *after* the event
has a later ``created`` than the event, so no comparison against a clock can
distinguish "issued after the eviction" from "issued by an authentication that
happened before it" — which is the whole question. The same reasoning is why
``Creator.kt_account_epoch`` is a counter rather than ``int(time.time())``
; see ``dj.apps.ktauth.epoch``.

Why the table is here and not in ``ktauth``
-------------------------------------------

``dj.apps.ktauth`` is a signing authority and is pinned by
``ktauth/tests/test_app_shape.py`` to own **no models and no migrations** — a
table of who asserted which key for which handle is precisely the directory
``THREAT-MODEL.md`` §4.1 bounds. This row is not that: it is one small integer
about an account's own bearer token, the same account column
``kt_account_epoch`` already lives on. So it belongs with ``Creator``.

Retention: the FK cascades, so a stamp cannot outlive its token — knox deletes
expired tokens lazily during authentication, ``/api/token/logoutall/`` deletes
them in bulk, and every ownership event deletes them all. There is no separate
sweep to forget to run.
"""

from django.db import models


class IssuedTokenEpoch(models.Model):
    """One row per issued ``knox.AuthToken``: the epoch it was minted against.

    ``token`` is the primary key, so the stamp is one row per token with no
    surrogate id and no way to have two disagreeing stamps for one credential.

    ``account_epoch`` is **not nullable and has no default**. A stamp that
    could be absent or zero would have to be interpreted at authentication
    time, and every interpretation except "refuse" reopens the hole — that is
    the  lesson (a control that substitutes a value when it cannot read
    one enforces nothing). ``dj.apps.ktauth.credentials`` guarantees the row
    exists by writing it from a ``post_save`` receiver on ``AuthToken``, so
    "no stamp" is unreachable through the ORM and is treated as a refusal
    rather than as a default.
    """

    token = models.OneToOneField(
        "knox.AuthToken",
        on_delete=models.CASCADE,
        primary_key=True,
        related_name="account_epoch_stamp",
        help_text="The bearer token this stamp belongs to.",
    )
    account_epoch = models.PositiveIntegerField(
        editable=False,
        help_text=(
            "Creator.kt_account_epoch as read in the same snapshot that "
            "validated the credential this token was issued for. "
            "Authentication refuses the token when the account has moved on."
        ),
    )

    class Meta:
        verbose_name = "Issued token epoch"
        verbose_name_plural = "Issued token epochs"

    def __str__(self) -> str:  # pragma: no cover - admin/debug convenience
        return f"{self.token_id[:8]}… @ epoch {self.account_epoch}"
