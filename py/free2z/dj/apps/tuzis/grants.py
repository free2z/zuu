"""Issue a 2Z platform-credit grant with its receipt -- the one shared path.

2Z are platform credits, never money: a grant mints spendable platform
balance from ``sys:promo``; it moves no ZEC and no card funds. Two callers
grant 2Z with a:class:`~dj.apps.tuzis.models.TuziGrant` receipt:

* ``manage.py grant_tuzis`` -- an operator grant with a reason;
*mod:`dj.apps.tuzis.welcome` -- the welcome grant every new account gets
  at sign-up.

Both go through:func:`issue_grant`, so a grant is always the same three
writes in one transaction: the receipt, the ``ledger.credit``
(``sys:promo -> user``, ref ``tuzi_grant:<receipt pk>``) and the balance the
credit reported, written back onto the receipt. Either all three commit or
none do.

**Exactly once per (account, idempotency key).** When the caller passes an
``idempotency_key``,:func:`issue_grant` first takes the account's row lock
(``ledger.lock_in_order``, which every 2Z writer takes first) and then looks
for an existing receipt with that key. Finding one raises
:class:`AlreadyGranted` and writes nothing. Because every grant takes that
same row lock before it looks, two grants for one account and one key
serialize, and the second always sees the first's receipt. This is what lets
an operator safely re-run a welcome grant that failed (``grant_tuzis
--idempotency-key welcome-grant:<id>``): if the original did land after all,
the re-run is refused instead of paying twice.
"""
import hashlib
import os
from decimal import Decimal

from django.db import connection, transaction

from dj.apps.ledger.models import TransferKey
from dj.apps.tuzis import ledger
from dj.apps.tuzis.models import TuziGrant

PROD_NAMES = frozenset({"prod"})

#Idempotency keys under this prefix are GLOBAL: at most one grant per key
#across every account, not per account. They are the sign-up welcome
#grant's keys (dj.apps.tuzis.welcome) -- ``welcome-grant:<account id>`` and
#``welcome-grant:<provider>:<hash>`` for an external identity that can be
#unlinked and re-used on a NEW account. A grant under such a key always
#posts to the ledger under the key itself, so the ledger's own key table
#(primary-key lookup) is the authoritative "already granted" record, for a
#sign-up and for an operator's ``grant_tuzis`` repair alike (codex review of
#: a repair that only checked its own account could pay an identity
#twice).
GLOBAL_KEY_PREFIX = "welcome-grant:"


def _lock_key(key: str) -> None:
    """Serialize every grant under one global key until commit."""
    lock_id = int.from_bytes(
        hashlib.sha256(key.encode("utf-8")).digest()[:8], "big", signed=True)
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_xact_lock(%s)", [lock_id])


class AlreadyGranted(Exception):
    """A receipt with this idempotency key already exists for this account."""

    def __init__(self, grant: TuziGrant):
        self.grant = grant
        super().__init__(
            f"TuziGrant #{grant.pk} already granted {grant.amount} 2Z to "
            f"{grant.username} under key {grant.idempotency_key!r}"
        )


def describe_environment():
    """What this process is about to write to, as far as it can tell.

    ``NAMESPACE`` is what the k8s ConfigMap (and ``cbenv.sh``) set; it is
    absent in a bare Cloud Build step such as DBCOPY. The database name is the
    ground truth either way, so it is always reported.
    """
    db = connection.settings_dict
    namespace = os.environ.get("NAMESPACE") or "<unset>"
    name = db.get("NAME") or "<unset>"
    host = db.get("HOST") or "<local>"
    is_prod = namespace in PROD_NAMES or str(name) in PROD_NAMES
    summary = (
        f"namespace={namespace} database={name}@{host} "
        f"settings={os.environ.get('DJANGO_SETTINGS_MODULE', '<unset>')}"
    )
    return {
        "namespace": namespace,
        "database": str(name),
        "host": str(host),
        "is_prod": is_prod,
        "summary": summary,
    }


def issue_grant(
    creator,
    amount,
    *,
    reason: str,
    operator: str,
    environment: str,
    idempotency_key: str = "",
    ledger_idem: str | None = None,
):
    """Credit ``amount`` 2Z from ``sys:promo`` to ``creator`` with a receipt.

    Returns ``(grant, balance_after)``. Raises:class:`AlreadyGranted` when
    ``idempotency_key`` is non-empty and a receipt with that key already
    exists for this account -- or, for a:data:`GLOBAL_KEY_PREFIX` key, for
    ANY account (``already.grant.creator_id`` says which). Nothing is written. Runs in its own
    ``transaction.atomic()`` -- a savepoint when the caller already holds a
    transaction, so a caller can keep other writes (an idempotency claim, the
    account itself) in the same commit.

    ``ledger_idem`` is the ledger operation key. It defaults to
    ``grant:<receipt pk>``, unique by construction. A global key ignores it
    and always posts under the key itself.

    Lock order: the account row (``ledger.lock_in_order``, as every 2Z writer
    takes first), then the global key's advisory lock.
    """
    amount = ledger.to_tuzis(amount)
    if amount <= 0:
        raise ValueError("a grant must be positive")
    with transaction.atomic():
        ledger.lock_in_order(creator)
        if idempotency_key and idempotency_key.startswith(GLOBAL_KEY_PREFIX):
            _lock_key(idempotency_key)
            ledger_idem = idempotency_key
            # Primary-key lookup: the cheap, authoritative check. The receipt
            # scan only runs when the key IS taken, to name the receipt.
            if TransferKey.objects.filter(idem=idempotency_key).exists():
                existing = (
                    TuziGrant.objects.filter(idempotency_key=idempotency_key)
                    .order_by("pk").first()
                )
                if existing is None:
                    raise RuntimeError(
                        f"the ledger already posted under {idempotency_key!r} "
                        "but no TuziGrant receipt carries it; refusing to grant"
                    )
                raise AlreadyGranted(existing)
        elif idempotency_key:
            existing = (
                TuziGrant.objects.filter(
                    creator=creator, idempotency_key=idempotency_key)
                .order_by("pk").first()
            )
            if existing is not None:
                raise AlreadyGranted(existing)
        # The receipt first, so it has a pk for the ledger to name (design
        # §10.1); then the credit (`sys:promo -> user`, keyed on the receipt
        # unless the caller has a natural key); then the balance the credit
        # reported.
        grant = TuziGrant.objects.create(
            creator=creator,
            username=creator.username,
            amount=amount,
            balance_after=Decimal("0"),
            reason=reason,
            operator=operator,
            environment=environment[:128],
            idempotency_key=idempotency_key or "",
        )
        balance = ledger.credit(
            creator, amount,
            source="sys:promo",
            ref_kind="tuzi_grant",
            ref_id=str(grant.pk),
            idem=ledger_idem or f"grant:{grant.pk}",
        )
        TuziGrant.objects.filter(pk=grant.pk).update(balance_after=balance)
        grant.balance_after = balance
    return grant, balance
