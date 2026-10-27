"""
Go through transactions to the free2z address and issue 2Z platform credits
for `buy_2z` memos.

2Z are platform credits, not money and not crypto. ZEC is what arrives on
chain; this command turns an observed, memo-tagged note into 2Z on a Creator's
balance and nothing else.

THREE THINGS THIS COMMAND IS CONTRACTUALLY REQUIRED TO DO
------------------------------------------------------------------------------
1. **Credit atomically.** `AtomicMiddleware` wraps HTTP writes; a management
   command runs in autocommit and gets none of it. The receipt and the credit
   go in one `transaction.atomic()` inside `dj.apps.tuzis.zec`, so a crash
   between them can no longer mark a note processed with nothing credited.

2. **Fail loudly, never quietly.** A cycle that could not credit prints a
   `CREDITING BLOCKED` line and does NOT print the heartbeat. A pricing outage
   or a per-note failure also exits non-zero, so `credit-loop.sh` can count
   consecutive failures and let systemd's `Restart=on-failure` become
   reachable. Aborting rather than crediting at a wrong rate is correct; being
   indistinguishable from "nothing to credit" was the bug.

3. **Emit a heartbeat.** Exactly one `cycle ok` line per successful cycle.
   `monitoring/log-metrics/zec-credit-cycle.json` counts it and
   `monitoring/alert-policies/zec-credit-cycle-absent.json` pages on its
   ABSENCE. A loop that silently stops emits no errors at all — that is the
   ~11-month-gap failure, and only absence-based alerting catches it.

4. **Say something during the wait.** A note below the confirmation floor is
   held for ~4 minutes at Zcash's 75-second target, and until now the buyer
   was told nothing at all during it — indistinguishable, from where they are
   sitting, from having lost the money. Every held `buy_2z` note gets a
   `ZEC_PENDING` event exactly once, deduplicated by `tuzis.ZecPendingNotice`
   because the loop re-reads the same note every cycle and `events.Event` has
   no uniqueness constraint of its own.

   Optionally — off unless two zatoshi caps are set — a small held note is
   credited immediately, and every instant credit is reconciled against the
   wallet at the start of every later cycle. See `dj.apps.tuzis.zec`.

The exact text of both lines is a contract with those metric files.
`py/dj/apps/g12f/test_zec_credit_integrity.py` reads the regexes back out of
the JSON and runs them against this command's real stdout, so renaming a line
breaks the test instead of silently killing the metric.
"""
import json
import codecs
from decimal import Decimal, InvalidOperation

from django.core.management.base import BaseCommand, CommandError
from zcashrpc.paymentd_mode import legacy_buy_producer

from zcashrpc.client import Client
from dj.apps.g12f.models.creator import Creator
from dj.apps.tuzis.zec import (
    CREDIT_BLOCKED_SIGNAL, CREDIT_UNBACKED_SIGNAL, AlreadyCredited,
    InstantCreditRefused, credit_zec_purchase, credit_zec_purchase_instantly,
    canonical_disposition_note, disposition_amount_from_tx,
    instant_credit_policy, note_output_index, note_pool, note_zatoshi,
    notify_pending_note, record_zec_memo_observation,
    unresolved_unbacked_credits, watch_instant_credits,
    ZecMemoDispositionConflict, ZecMemoDispositionIdentityError,
)
from dj.apps.pricing.service import current_tuzis_per_zec, PricingUnavailable

# TODO: make dynamic instead of hardcoded
FREE2Z_ADDRESS = (
    "zs1lm4vumxdpuz08w237n0lpxz490uq5nxasz6mql555f96hql4h7kc3ucf2a42j7mp0slck2uvjjk"
)

# Counted by monitoring/log-metrics/zec-credit-cycle.json. One per healthy
# cycle, and never printed by a cycle that failed to credit something it
# should have.
#
# The `*_SIGNAL` naming is load-bearing: `py/gcp/tests/test_alert_policy_
# contract.py` collects every such constant and fails if no monitoring filter
# watches it, which is the  direction (a phrase the code emits that pages
# nobody).
CREDIT_CYCLE_OK_SIGNAL = "credit_creators: cycle ok"
HEARTBEAT = (
    CREDIT_CYCLE_OK_SIGNAL
    + " - scanned {scanned} notes, credited {credited} notes for {tuzis} 2Z"
)

# Counted by monitoring/log-metrics/zec-credit-blocked.json. This pages:
# ZEC is arriving and 2Z are not being issued for it.
BLOCKED = "credit_creators: " + CREDIT_BLOCKED_SIGNAL + " - {reason}"

# Counted by monitoring/log-metrics/zec-credit-unbacked.json. This is the
# mirror image of BLOCKED and a strictly worse incident: 2Z were issued for a
# note that is no longer in the wallet, so somebody holds spendable platform
# credits and we hold no ZEC for them. Only reachable from the instant-credit
# path.
UNBACKED = "credit_creators: " + CREDIT_UNBACKED_SIGNAL + " - {reason}"


def extract_json(text):
    start = text.find('{')
    end = text.rfind('}') + 1
    return text[start:end]


# Caps on the per-cycle unreadable-memo trace. The wallet re-reports EVERY
# historical note on every scan, so an unbounded trace is not "one line per bad
# payment", it is one line per bad payment PER CYCLE, forever -- and the
# receive address is public, so anyone can add to that permanent set for the
# price of a dust output. (Found by the codex adversarial review.)
#
# The two classes are capped differently on purpose. The wallet query has no
# ordering, so a single low cap would let 20 pieces of old garbage permanently
# occupy every slot while a real customer's malformed purchase sat at position
# 21, uncredited and never named in the logs -- the exact silence  is
# about, reintroduced by its own fix. A memo that still contains the literal
# `buy_2z` is a visible attempt to buy, so it gets a far higher ceiling: 100
# simultaneous malformed purchase memos is an attack, not a customer, and the
# summary still carries the true count either way.
MAX_UNREADABLE_MEMO_LINES = 20
MAX_UNREADABLE_PURCHASE_LINES = 100
PURCHASE_ACTION = "buy_2z"
# Deliberately NOT a `*_SIGNAL` constant: the aggregate BLOCKED line below is
# the monitored signal, while this per-note summary remains informational.
UNREADABLE_PURCHASE_SUMMARY = (
    "credit_creators: {total} note(s) carried a memo naming {action} that "
    "does not parse ({shown} listed above); that is ZEC received and 2Z NOT "
    "issued -- a human has to read those memos"
)
UNREADABLE_MEMO_SUMMARY = (
    "credit_creators: {total} note(s) carried an unreadable memo this cycle "
    "({shown} shown); none of them named {action}, so none is believed to be "
    "a purchase"
)

# ZIP 302 (https://zips.z.cash/zip-0302). `0xF6` followed by all zeros is THE
# canonical "no memo". Everything else with a first byte above 0xF4 is a
# reserved or opaque NON-TEXT format -- deliberately NOT treated as absent, so
# it still gets a trace: a reserved format is indistinguishable from a
# corrupted purchase memo without one. (Narrowed on the codex adversarial
# review, which caught the first cut swallowing 0xF5 and 0xF7-0xFF.)
MEMO_NO_MEMO_MARKER = 0xF6
MEMO_FIRST_NON_TEXT_BYTE = 0xF5


def _names_a_purchase(raw_memo, memo) -> bool:
    """Does this unparseable memo still visibly say `buy_2z`?

    It decides whether the note pages or is filed as a stranger's noise, so
    every representation the action could survive in has to be checked:

    * the decoded bytes, when the hex decoded;
    * the HEX TEXT itself, for the hex encoding of the action
      (``6275795f327a``). This is the case that matters and the one the first
      cut got wrong: when the hex does *not* decode there are no decoded
      bytes, and searching the hex text for the plaintext word can never match
      -- so a real purchase whose memo was corrupted in transit was filed as
      generic garbage, capped, and paged nobody. (Found by the codex
      adversarial review.)
    * the field as plain text, in case a backend hands us an unencoded memo.

    ``str()`` and ``errors="ignore"`` throughout: a wallet backend may hand us
    bytes, and no exception raised while classifying a LOG LINE may be allowed
    to abort a crediting cycle.
    """
    needle = PURCHASE_ACTION.encode()
    if raw_memo is not None and needle in raw_memo:
        return True
    try:
        text = memo.decode("utf-8", "ignore") if isinstance(
            memo, (bytes, bytearray)) else str(memo)
    except Exception:
        return False
    lowered = text.lower()
    return needle.hex() in lowered or PURCHASE_ACTION in text


def memo_is_absent(raw_memo: bytes) -> bool:
    """True when these bytes mean "this note carries no memo at all".

    A note without a memo is not a note with a broken one, and conflating them
    turns every ordinary tip to a PUBLIC address into a permanent, repeating
    "unreadable memo" line. Three encodings mean absent:

    * empty -- ``zcashrpc/wallet_sqlite_client.py`` emits ``memo: ""`` (not a missing
      key) for a note whose memo column is NULL, so the ``KeyError`` branch in
      ``handle`` never sees it;
    * all zero bytes -- a zeroed buffer;
    * ``0xF6`` followed by all zeros -- the ZIP 302 "no memo" encoding, which
      is what the wallet's own dummy note carries. It is also not valid UTF-8,
      so it used to be reported as a corrupted memo on every single cycle.
    """
    if not raw_memo:
        return True
    if not any(raw_memo):
        return True
    return raw_memo[0] == MEMO_NO_MEMO_MARKER and not any(raw_memo[1:])


# --- one decoder, three callers -------------------------------------------
#  extracted `parse_buy_2z` so the confirmed pass and the held-note pass
# could not drift: a memo one of them reads as a purchase and the other does
# not means telling a buyer we saw their payment and then never crediting it.
# That invariant is load-bearing, so 's trace is built on the SAME
# decoder rather than beside it -- otherwise the classification could disagree
# with the parse, which is the identical failure one level up.

def parse_amount(tx):
    """The note's value as the Decimal the receipt column stores, or None."""
    if 'amountZat' in tx:
        # Native wallet notes include integer zatoshis. Their display float
        # must never replace the authoritative amount in a captured receipt.
        zat = tx['amountZat']
        if type(zat) is not int or not 0 <= zat <= 21_000_000 * 100_000_000:
            return None
        return (Decimal(zat) / 100_000_000).quantize(Decimal('.00000001'))
    try:
        amount = Decimal(str(tx['amount'])).quantize(Decimal('.00000001'))
        return amount if amount.is_finite() and 0 <= amount <= 21_000_000 else None
    except (InvalidOperation, KeyError, TypeError, ValueError):
        return None


def read_memo(tx):
    """Decode one note's memo. Returns ``(purchase, reason, raw_memo)``.

    * ``purchase`` -- ``(ascii_memo, username)`` when this note is a
      ``buy_2z``, else ``None``.
    * ``reason`` -- why the memo could not be READ AT ALL, or ``None``. A memo
      that decodes cleanly but is somebody else's business (not a purchase, or
      no memo at all) has ``reason is None``: that is not a defect and must
      stay silent, because the receive address is public.
    * ``raw_memo`` -- the decoded bytes, or ``None`` if the hex never decoded.

    The reason exists so 's trace comes off the same decode as the parse.
    """
    try:
        memo = tx['memo']
    except KeyError:
        # No memo field at all: it cannot be a purchase memo, and the address
        # is public, so silence is correct here.
        return None, None, None

    raw_memo = None
    try:
        raw_memo = codecs.decode(memo, 'hex')
    except Exception as exc:
        return None, f"not valid hex ({exc})", None

    if memo_is_absent(raw_memo):
        # No memo at all -- a plain tip or donation. Silent, exactly like a
        # missing `memo` key. A tip is not a broken purchase.
        return None, None, raw_memo
    if raw_memo[0] >= MEMO_FIRST_NON_TEXT_BYTE:
        # Present, but a ZIP 302 reserved/opaque format -- it can never be a
        # buy_2z memo, and calling it "not valid UTF-8" sends whoever reads
        # the log hunting a corruption that is not there.
        return None, (f"a reserved non-text memo format (ZIP 302, first byte "
                      f"0x{raw_memo[0]:02x})"), raw_memo

    try:
        ascii_memo = raw_memo.decode().replace("\x00", "")
    except Exception as exc:
        return None, f"not valid UTF-8 ({exc})", raw_memo
    try:
        json_memo = json.loads(extract_json(ascii_memo))
    except Exception as exc:
        return None, f"not JSON ({exc})", raw_memo
    if not isinstance(json_memo, dict):
        return None, "parses but is not a JSON object", raw_memo
    if json_memo.get('act') != PURCHASE_ACTION:
        # Readable, and not for us. Silent.
        return None, None, raw_memo
    return (ascii_memo, json_memo.get('id')), None, raw_memo


def parse_buy_2z(tx):
    """``(ascii_memo, username)`` if this note is a ``buy_2z``, else ``None``.

    The held-note pass's view of:func:`read_memo`. Kept as its own name so
    's call site reads as it did, and so there is exactly one decoder.
    """
    return read_memo(tx)[0]


def note_key(tx):
    """The ``(txid, pool, output_index)`` identity of a note."""
    return (tx.get('txid'), note_pool(tx), note_output_index(tx))


def carries_no_value(tx, amount) -> bool:
    """Whether this note provably moved zero ZEC to us.

    A zero-value shielded output with a memo is valid on chain and costs its
    sender only a transaction fee. No ZEC arrived, so there is nothing to turn
    into 2Z and nothing for an operator to reconcile -- and a zero amount can
    never become a ``ZecMemoDisposition`` row (the table requires a positive
    amount). Treating such a note as a blocked purchase would therefore arm a
    CRITICAL page that no operator action can ever clear, which anyone who
    knows the public receive address could do on purpose.

    ``amountZat`` is authoritative when the adapter reports it; ``bool`` is
    rejected because ``False == 0``.
    """
    zat = tx.get('amountZat')
    if zat is not None:
        return isinstance(zat, int) and not isinstance(zat, bool) and zat == 0
    return amount == 0


def valid_creator_username(username) -> bool:
    """Whether a parsed memo contains a usable recipient identity."""
    return isinstance(username, str) and bool(username.strip())


class Command(BaseCommand):
    help = 'Issue 2Z platform credits for buy_2z memos received on chain'

    @legacy_buy_producer(refusal=CommandError)
    def handle(self, *args, **kwargs):
        # paymentd-producer-guard-v1: no direct/manual legacy writer after cutover.
        from zcashrpc.paymentd_mode import LegacyProducerDisabled, require_legacy_producer
        try:
            require_legacy_producer()
        except LegacyProducerDisabled as exc:
            raise CommandError(str(exc)) from exc
        z = Client()

        # A misconfigured WALLET_DB (or a missing ZCASH_USER) does not raise:
        # both clients fall back to a DUMMY mode that returns one hardcoded
        # fake note. Crediting nothing from a fake wallet used to be
        # indistinguishable from crediting nothing from a real, quiet one, so
        # a broken deploy could heartbeat healthily forever. Found by the codex
        # adversarial review.
        #
        # Exit NON-ZERO. The BLOCKED line only pages once the Ops Agent is
        # installed and the policies applied, and on a fresh or broken VM
        # neither is true -- which is exactly when WALLET_DB is most likely to
        # be wrong. A non-zero exit at least drives the loop's
        # consecutive-failure counter, so `systemctl show -p NRestarts` tells
        # the truth on the box itself. (Found by the codex adversarial
        # review.)
        if getattr(z, "dummy", False):
            print(BLOCKED.format(reason=(
                "the wallet client is in DUMMY mode -- WALLET_DB does not "
                "point at a readable wallet, so no real note can be seen and "
                "nothing will ever be credited"
            )))
            raise CommandError(
                "wallet client is in dummy mode; refusing to report a cycle")

        # A pool the wallet stores notes in and `recieved_by` never SELECTs
        # from. `recieved_by` UNIONs a hardcoded list of tables;
        # librustzcash adds a shielded pool by adding a table, and the payment host's
        # wallet upgrades on its own schedule with no PR here. The live wallet
        # already carries `ironwood_received_notes`, and the published unified
        # address really does have a transparent receiver an exchange can pay.
        #
        # Every symptom of that is `Saw 0 notes for 0 ZEC` -- the same line an
        # unpaid wallet emits -- which is exactly the ambiguity  is about,
        # except with real money behind it. Report it BEFORE pricing: the funds
        # are sitting there whether or not a rate is available.
        #
        # Only this command reports it, though both commands read the same
        # wallet: the condition is a property of the wallet file, so having
        # `credit_pages_unified` page for it too would just double the noise
        # on one fact.
        blind_pools = []
        try:
            blind_pools = list(getattr(z, "unreadable_pools", lambda: [])())
        except Exception as exc:
            # Never let an advisory check take out a cycle that could still
            # credit. Say so rather than swallowing it.
            print(BLOCKED.format(reason=(
                f"could not check the wallet for unreadable pools: {exc!r}")))
        for table, count, reason in blind_pools:
            print(BLOCKED.format(reason=(
                f"{count} note(s) are stored in `{table}`, which the wallet "
                f"adapter does not read, so they can never be credited "
                f"({reason})"
            )))

        scanned = 0
        credited = 0
        already = 0
        failed = 0
        collapsed = 0
        unresolved = 0
        unreadable = 0
        unreadable_purchases = 0
        unreadable_other = 0
        disposition_blocked = 0
        disposition_conflicts = 0
        total_zec = Decimal("0")
        total_tuzis = Decimal("0")
        # (txid, output_index) -> amount, for THIS scan only. Used to notice a
        # wallet backend that cannot tell two notes of one transaction apart.
        seen = {}

        confirmed = list(z.recieved_by(FREE2Z_ADDRESS))
        # Notes the wallet HAS but that are not yet buried deep enough to
        # credit. Empty on a wallet adapter that predates this, and every
        # branch below is a no-op on an empty list -- so a stale adapter on
        # the VM degrades to exactly today's behaviour rather than crashing.
        held = list(getattr(z, "pending_notes", []) or [])

        # ------------------------------------------------------------------
        # Are the instant credits we already issued still backed by ZEC we
        # actually hold? Detect, mark, brake, page -- never auto-reverse. The
        # argument is in dj.apps.tuzis.zec.watch_instant_credits.
        #
        # THIS RUNS FIRST, BEFORE ANY NEW CREDIT, and the ordering is
        # load-bearing rather than tidy. Running it at the end of the cycle
        # meant that on the very cycle we discovered an unbacked credit we
        # had already handed out another one, because the brake was set after
        # the money moved. Caught by
        # `test_a_vanished_instant_credit_pages_halts_and_reverses_nothing`.
        # A note that matured during this cycle is in `confirmed` either way,
        # so nothing is lost by looking early.
        # ------------------------------------------------------------------
        settled, vanished, unverifiable = watch_instant_credits(
            confirmed_keys={note_key(tx) for tx in confirmed},
            pending_keys={note_key(tx) for tx in held},
            # An adapter with no `pending_notes` cannot show us young notes,
            # so an empty `pending_keys` from it means "cannot see" and not
            # "none exist". Accusing a young note on that basis is what an
            # ordinary partial VM rollback would trigger.
            pending_visible=hasattr(z, "pending_notes"),
        )
        for receipt in settled:
            print(f"instant credit {receipt} reached the confirmation floor; "
                  f"off the watch list")
        for receipt in vanished:
            print(UNBACKED.format(reason=(
                f"{receipt} was credited instantly at "
                f"{receipt.confirmations_at_credit} confirmation(s) for "
                f"{receipt.amount_zec} ZEC ({receipt.tuzis_credited} 2Z to "
                f"creator {receipt.creator_id}) and its note is no longer in "
                f"the wallet. NOTHING HAS BEEN REVERSED. Instant crediting is "
                f"halted platform-wide until a human clears "
                f"vanish_resolved_at on this receipt."
            )))
        if unverifiable:
            print(UNBACKED.format(reason=(
                f"{len(unverifiable)} instant credit(s) cannot be verified "
                f"this cycle: the wallet reported no young notes and, for "
                f"{len(unverifiable)} of them, no matching confirmed note "
                f"either. That is far more likely to be a resync, a restore "
                f"or an adapter that cannot report held notes than "
                f"simultaneous double-spends, so nothing has been marked "
                f"vanished -- but until the wallet answers, we cannot say "
                f"our credits are backed."
            )))

        # STILL UNRESOLVED, ON EVERY LATER CYCLE. `watch_instant_credits`
        # only ever returns a receipt once -- the second cycle excludes it,
        # because `vanished_at` is set. Without this line the incident is
        # announced exactly once: the metric stops incrementing, the policy
        # auto-closes an hour later, every dashboard goes green, and nothing
        # has been reversed or decided. That is precisely the shape of alert
        # this repo has been burned by. (Found by the codex
        # adversarial review.)
        #
        # It re-pages every cycle until `manage.py
        # resolve_unbacked_zec_credit` is run, which is deliberate: the only
        # thing that clears it is a human looking at the receipt.
        standing = list(unresolved_unbacked_credits().exclude(
            pk__in=[r.pk for r in vanished]))
        for receipt in standing:
            print(UNBACKED.format(reason=(
                f"{receipt} is STILL UNRESOLVED (vanished at "
                f"{receipt.vanished_at.isoformat()}, "
                f"{receipt.tuzis_credited} 2Z to creator "
                f"{receipt.creator_id}). Instant crediting remains halted. "
                f"Run `manage.py resolve_unbacked_zec_credit` to see it and "
                f"release the halt once a decision has been made."
            )))

        # Live, spread-adjusted 2Z-per-ZEC rate. Snapshot it once
        # per run so every note in this scan credits at the same rate; abort
        # the run rather than credit at a wrong rate.
        #
        #aborting is right, exiting 0 was not. A pricing outage used
        # to print one line, return 0, and look exactly like "nothing to
        # credit" while payments kept arriving uncredited.
        #
        # DELIBERATELY AFTER `watch_instant_credits`. Pricing gates ISSUING
        # new 2Z; it must never gate RECONCILING 2Z already issued. This used
        # to sit above the wallet reads, so a pricing outage aborted the cycle
        # before the double-spend watchdog ran at all -- and  made that
        # path far more reachable by bounding the stale-rate fallback to
        # CREDIT_MAX_SNAPSHOT_AGE_SECONDS. The concrete failure: an instant
        # credit is issued, the exchanges then go quiet for 15 minutes, the
        # sender double-spends, and every cycle exits at the pricing check --
        # so `vanished_at` is never set, CREDIT UNBACKED never fires, and the
        # platform-wide brake is never armed while the 2Z stay spendable.
        # (Found by the codex adversarial review of the  merge.)
        from dj.apps.economy.models import EconomicPolicy
        economic_policy = EconomicPolicy.objects.get(pk=True)
        if economic_policy.version == 1 or economic_policy.fenced:
            # Durable wallet facts precede confirmed processing-rate issuance.
            # A pricing outage must not erase receipt observation.
            tuzis_per_zec = None
            print('Reconciling confirmed ZEC payments at the current processing rate')
        else:
            try:
                tuzis_per_zec = current_tuzis_per_zec()
            except PricingUnavailable as exc:
                print(BLOCKED.format(reason=f"no live ZEC price available: {exc}"))
                raise CommandError(
                    "no live ZEC price available; credited nothing this cycle")
            print(f"Crediting at {tuzis_per_zec} 2Z/ZEC")

        for tx in confirmed:
            amount = parse_amount(tx)
            if amount is None:
                failed += 1
                print(BLOCKED.format(
                    reason=f"unreadable amount on {tx.get('txid')!r}"))
                continue

            scanned += 1
            total_zec += amount

            if economic_policy.version == 1 or economic_policy.fenced:
                from dj.apps.economy.captured_notes import capture_wallet_note
                from dj.apps.tuzis.models import ZecCreditReceipt
                try:
                    txid, pool, index = note_key(tx)
                    previously_credited = ZecCreditReceipt.objects.filter(
                        txid=txid, pool=pool, output_index=index).exists()
                    result = capture_wallet_note(tx)
                except Exception as exc:
                    failed += 1
                    print(BLOCKED.format(reason=f"durable note processing requires retry: {tx.get('txid')}: {exc!r}"))
                    continue
                if result.credited:
                    if previously_credited:
                        already += 1
                    else:
                        credited += 1
                        total_tuzis += result.receipt.tuzis_credited
                    # Actual issuance notifications belong to the funded ledger adapter.
                elif result.status not in {'ignored_zero','observed_nonpurchase','resolved_observation'}:
                    unresolved += 1
                    print(BLOCKED.format(reason=f"note retained as {result.resolution_id}: {result.reason}"))
                continue

            purchase, reason, raw_memo = read_memo(tx)

            #a note that HAS a memo but whose memo cannot be read
            # (bad hex, bad UTF-8, bad JSON, not an object) used to vanish in
            # a bare `continue` -- a detected payment with no trace at all.
            #
            # Which trace depends on whether it looks like a purchase:
            #
            #   names `buy_2z` -> a loud, capped line plus an aggregate page;
            #       a durable disposition makes the page clearable.
            #   does not      -> one capped informational line. The receive
            #       address is PUBLIC and strangers send arbitrary memos;
            #       paging on those trains people to ignore pages.
            #   absent        -> nothing at all. A tip is not a broken
            #       purchase.
            #
            # Exit code is unchanged in every branch.
            if reason is not None:
                unreadable += 1
                looks_like_purchase = _names_a_purchase(raw_memo, tx.get('memo'))
                if looks_like_purchase and carries_no_value(tx, amount):
                    # Informational only: see carries_no_value. Counted with
                    # the other non-purchase noise so it can never page.
                    _txid, _pool, _index = note_key(tx)
                    unreadable_other += 1
                    if unreadable_other <= MAX_UNREADABLE_MEMO_LINES:
                        print(f"note {_txid!r}:{_pool or 'unknown'}:{_index} "
                              f"carries 0 ZEC and an unreadable memo naming "
                              f"{PURCHASE_ACTION} ({reason}); no ZEC arrived, "
                              f"so there is nothing to credit")
                    continue
                if looks_like_purchase:
                    # Persist every valid observation before applying the
                    # bounded log cap. This path deliberately has stricter
                    # identity rules than receipts: a missing index must not
                    # fall back to index zero and suppress a different note.
                    try:
                        _txid, _pool, _index = canonical_disposition_note(tx)
                        observation_amount = disposition_amount_from_tx(tx)
                        disposition = record_zec_memo_observation(
                            txid=_txid,
                            pool=_pool,
                            output_index=_index,
                            amount_zec=observation_amount,
                        )
                    except (ZecMemoDispositionIdentityError, ValueError):
                        disposition_blocked += 1
                        if disposition_blocked <= MAX_UNREADABLE_PURCHASE_LINES:
                            print(
                                "unparseable buy_2z note has an unusable "
                                "wallet identity or amount; fix the wallet "
                                "adapter before it can be dispositioned"
                            )
                        continue
                    except ZecMemoDispositionConflict:
                        # The first amount/classification is authoritative.
                        # A conflicting repeat remains an active page and can
                        # never overwrite or suppress the audit row.
                        disposition_conflicts += 1
                        if disposition_conflicts <= MAX_UNREADABLE_PURCHASE_LINES:
                            print(
                                "unparseable buy_2z observation conflicts "
                                "with its durable first observation; review "
                                "the wallet adapter and audit row"
                            )
                        continue

                    if disposition.decision is not None:
                        # A disposition retires only this still-unparseable
                        # observation. A later parseable purchase continues
                        # through the normal receipt path below.
                        continue

                    unreadable_purchases += 1
                    note_id = f"{_txid}:{_pool}:{_index}"
                    if unreadable_purchases <= MAX_UNREADABLE_PURCHASE_LINES:
                        print(f"note {note_id} carries {disposition.amount_zec} ZEC and a memo "
                              f"that names {PURCHASE_ACTION} but does not "
                              f"parse ({reason}); it is very likely a purchase "
                              f"and a human has to read it")
                else:
                    _txid, _pool, _index = note_key(tx)
                    note_id = f"{_txid!r}:{_pool or 'unknown'}:{_index}"
                    unreadable_other += 1
                    if unreadable_other <= MAX_UNREADABLE_MEMO_LINES:
                        print(f"note {note_id} carries {amount} ZEC with an "
                              f"unreadable memo ({reason}); it does not name "
                              f"{PURCHASE_ACTION}, so it is most likely not a "
                              f"purchase")
                continue

            if purchase is None:
                # Readable, and not a buy_2z. Somebody else's business.
                continue
            ascii_memo, username = purchase
            action = PURCHASE_ACTION
            memo = tx['memo']

            txid = tx['txid']
            output_index = note_output_index(tx)
            # Sapling `output_index` and Orchard `action_index` are pool-local
            # namespaces, so the pool is part of the note's identity.
            pool = note_pool(tx)
            print(f"ACTION={action} AMOUNT={amount}")

            # (b): one transaction can pay several outputs to us and the
            # wallet emits one row per note. Both wallet schemas store at most
            # ONE row per (transaction, output index) -- `sapling_received_
            # notes` and `orchard_received_notes` are unique on it, and so is
            # zcashd's `z_listreceivedbyaddress` -- so a repeat inside a single
            # scan can only mean the backend is not reporting an index at all
            # and two distinct notes have been collapsed onto index 0.
            #
            # An earlier revision only flagged this when the AMOUNTS differed,
            # which silently under-credited two equal-value purchases in one
            # transaction -- a real case, since a fixed 2Z package price makes
            # equal amounts the LIKELY shape, not the exotic one. Found by the
            # codex adversarial review. Comparing memos is not enough either:
            # two identical payments from one buyer are genuinely
            # indistinguishable without an index. Page on every repeat.
            key = (txid, pool, output_index)
            if key in seen:
                collapsed += 1
                print(BLOCKED.format(reason=(
                    f"two notes of {txid} both report {pool or 'unknown'} "
                    f"output index {output_index} "
                    f"({seen[key]} ZEC and {amount} ZEC); the "
                    f"wallet backend is not reporting a per-note index, so "
                    f"this payment cannot be credited safely"
                )))
                continue
            seen[key] = amount

            if not valid_creator_username(username):
                unresolved += 1
                print(BLOCKED.format(reason=(
                    f"{txid}:{output_index} is a buy_2z payment with a "
                    "missing or invalid recipient identity; nobody can be "
                    "credited without a human deciding who it belongs to"
                )))
                continue

            try:
                from dj.apps.economy.funding import funding_note_recipient
                creator = funding_note_recipient(memo_plain=ascii_memo, username=username)
                if creator is None:
                    raise Creator.DoesNotExist
            except Creator.DoesNotExist:
                # Past `act == "buy_2z"` this is a real payment with a
                # recipient we cannot resolve -- a typo, a renamed or deleted
                # account. It never resolves itself on a later cycle, so
                # skipping it quietly meant the buyer sent ZEC, got no 2Z, and
                # both policies stayed green forever. (Found by the codex
                # adversarial review.) Page instead; a human has to decide who
                # it belongs to.
                unresolved += 1
                print(BLOCKED.format(reason=(
                    f"{txid}:{output_index} is a buy_2z payment of {amount} "
                    "ZEC for an unresolved recipient; nobody can be "
                    "credited without a human deciding who it belongs to"
                )))
                continue

            try:
                receipt = credit_zec_purchase(
                    creator=creator,
                    txid=txid,
                    output_index=output_index,
                    pool=pool,
                    amount_zec=amount,
                    tuzis_per_zec=tuzis_per_zec,
                    memo=memo,
                    memo_plain=ascii_memo,
                    action=action,
                    confirmations=tx.get("confirmations"),
                )
            except AlreadyCredited:
                already += 1
                continue
            except Exception as exc:
                # Was a bare `except Exception: continue`. Swallowing this is
                # what turned an uncredited payment into a silent one.
                failed += 1
                print(BLOCKED.format(reason=(
                    f"could not credit {txid}:{output_index} for "
                    f"{username}: {exc!r}"
                )))
                continue

            if getattr(receipt, 'credited', True) is False:
                unresolved += 1
                print(BLOCKED.format(reason=f"note {txid}:{pool}:{output_index} retained as {receipt.resolution_id}: {receipt.reason}"))
                continue
            credited += 1
            total_tuzis += receipt.tuzis_credited
            if getattr(receipt, "record_conflict", False):
                # Record-keeping only: g12f.Transaction is keyed on the bare
                # txid so it can hold just one note per transaction. The 2Z
                # were issued correctly; we simply did not store a second row.
                print(
                    f"note {txid}:{output_index} credited; g12f.Transaction "
                    f"already holds another note of this transaction, so no "
                    f"second record row was written"
                )

        if unreadable_purchases:
            # This is ZEC that arrived and 2Z that were not issued, so it is a
            # clearable instance of the blocked-payment signal. A disposition
            # row retires this exact note on the next scan. The monitored line
            # carries only an aggregate and the safe command name; memo
            # contents and user-supplied identity data are not logged here.
            print(BLOCKED.format(reason=(
                f"{unreadable_purchases} unparseable {PURCHASE_ACTION} "
                f"note(s) have no disposition; review and record each one "
                f"with `manage.py dispose_zec_memo`"
            )))
            print(UNREADABLE_PURCHASE_SUMMARY.format(
                total=unreadable_purchases,
                action=PURCHASE_ACTION,
                shown=min(unreadable_purchases,
                          MAX_UNREADABLE_PURCHASE_LINES)))

        if disposition_blocked or disposition_conflicts:
            print(BLOCKED.format(reason=(
                f"{disposition_blocked + disposition_conflicts} unparseable "
                f"{PURCHASE_ACTION} observation(s) could not be durably "
                "identified or reconciled; fix the wallet adapter or review "
                "the conflicting audit row"
            )))

        if unreadable_other:
            print(UNREADABLE_MEMO_SUMMARY.format(
                total=unreadable_other,
                action=PURCHASE_ACTION,
                shown=min(unreadable_other, MAX_UNREADABLE_MEMO_LINES)))

        # ------------------------------------------------------------------
        # HELD NOTES. The wallet can see these; they are simply not buried
        # deep enough yet. Two things happen to each of them, and the second
        # one is optional.
        #
        # 1. THE BUYER IS TOLD, ALWAYS. This costs nothing, risks nothing and
        #    assumes nothing about the chain. Before it, a buyer who had just
        #    sent real ZEC into a shielded address got no signal of any kind
        #    for ~4 minutes -- which is indistinguishable, from where they are
        #    sitting, from having lost the money. That silence is the actual
        #    product defect; the confirmation floor is not.
        #
        # 2. SMALL ONES MAY BE CREDITED NOW. Off by default: with neither cap
        #    set this branch is unreachable and the loop behaves exactly as it
        #    did before. See dj.apps.tuzis.zec for the risk argument and why
        #    the cap is per-note AND per-day.
        # ------------------------------------------------------------------
        policy = instant_credit_policy()
        instant = 0
        noticed = 0
        notify_failures = 0
        for tx in held:
            amount = parse_amount(tx)
            if amount is None:
                # Not counted as `failed`: a held note is not due yet, so a
                # cycle must not go red over one. It gets the full treatment,
                # including the BLOCKED line, when it matures.
                continue
            if economic_policy.version == 1 or economic_policy.fenced:
                from dj.apps.economy.captured_notes import capture_wallet_note
                try:
                    capture_wallet_note(tx)
                except Exception as exc:
                    notify_failures += 1
                    print(BLOCKED.format(reason=f"durable pending note processing requires retry: {tx.get('txid')}: {exc!r}"))
                continue
            parsed = parse_buy_2z(tx)
            if parsed is None:
                continue
            ascii_memo, username = parsed
            txid = tx['txid']
            output_index = note_output_index(tx)
            pool = note_pool(tx)
            confirmations = tx.get("confirmations") or 0

            key = (txid, pool, output_index)
            if key in seen:
                # The same collapse guard as the confirmed pass. Do not
                # notify and do not credit two notes we cannot tell apart --
                # it would be one buyer's name on another buyer's money.
                continue
            seen[key] = amount

            if not valid_creator_username(username):
                # The confirmed pass owns the alert for an unresolved
                # recipient. Do not page twice while this note is merely
                # waiting for confirmations.
                continue

            try:
                from dj.apps.economy.funding import funding_note_recipient
                creator = funding_note_recipient(memo_plain=ascii_memo, username=username)
                if creator is None:
                    raise Creator.DoesNotExist
            except Creator.DoesNotExist:
                # Deliberately quiet HERE and loud later. The confirmed pass
                # pages for exactly this, and paging twice for one payment --
                # once while it is merely young -- would train the responder
                # to ignore the line.
                continue

            from dj.apps.economy.models import EconomicPolicy
            economic_policy = EconomicPolicy.objects.get(pk=True)
            if economic_policy.version == 1 or economic_policy.fenced:
                from dj.apps.economy.captured_notes import capture_wallet_note
                capture_wallet_note(tx)
                # This pending funding status carries no guessed credit
                # amount and cannot emit a legacy positive-credit event.
                continue
            if policy.enabled and economic_policy.version == 0 and not economic_policy.fenced:
                try:
                    receipt = credit_zec_purchase_instantly(
                        amount_zat=note_zatoshi(tx, amount),
                        policy=policy,
                        creator=creator,
                        txid=txid,
                        output_index=output_index,
                        pool=pool,
                        amount_zec=amount,
                        tuzis_per_zec=tuzis_per_zec,
                        memo=tx['memo'],
                        memo_plain=ascii_memo,
                        action="buy_2z",
                        confirmations=confirmations,
                    )
                except AlreadyCredited:
                    already += 1
                    continue
                except InstantCreditRefused as exc:
                    # Informational, not an alert: declining to take a risk is
                    # the system working. The buyer still gets told below.
                    print(f"holding {txid}:{output_index} for confirmations "
                          f"- {exc.reason}")
                except Exception as exc:
                    failed += 1
                    print(BLOCKED.format(reason=(
                        f"could not instantly credit {txid}:{output_index} "
                        f"for {username}: {exc!r}"
                    )))
                    continue
                else:
                    instant += 1
                    credited += 1
                    total_tuzis += receipt.tuzis_credited
                    print(f"note {txid}:{output_index} credited INSTANTLY at "
                          f"{confirmations} confirmation(s) for {username} "
                          f"({amount} ZEC)")
                    # They get the BOUGHT_TUZI event. Telling them we are
                    # "waiting for confirmation" as well would be a lie.
                    continue

            try:
                notice = notify_pending_note(
                    creator=creator,
                    txid=txid,
                    output_index=output_index,
                    pool=pool,
                    amount_zec=amount,
                    confirmations=confirmations,
                    tuzis_per_zec=tuzis_per_zec,
                )
            except Exception as exc:
                # A NOTIFICATION MUST NEVER TAKE OUT A MONEY PATH. The
                # concrete way this happens: `the deployment checkout` on the payment host is a
                # hand-unpacked tarball, and a partial copy that
                # brings the credit command but not `events/models.py` gives
                # an `Event` model with no `ZEC_PENDING` template. The
                # post_save signal calls `to_dict()` synchronously, which
                # raises `KeyError`, which would otherwise abort the whole
                # cycle -- and keep aborting it, so a cosmetic drift becomes
                # a total crediting outage. (Found by the codex adversarial
                # review.)
                #
                # It is still not silent: the heartbeat is withheld, so a
                # PERSISTENTLY broken notifier trips the absence policy while
                # a one-off blip does not. The right sensitivity for
                # something that is not money.
                notify_failures += 1
                notice = None
                print(f"!! could not tell {username} about "
                      f"{txid}:{output_index}: {exc!r}")
            if notice is not None:
                noticed += 1
                print(f"told {username} we can see {txid}:{output_index} "
                      f"({amount} ZEC, {confirmations} confirmation(s))")

        if noticed or instant:
            print(f"{len(held)} held note(s): {instant} credited instantly, "
                  f"{noticed} buyer(s) notified")

        print(f"Saw {scanned} notes for {total_zec} ZEC "
              f"({credited} credited, {already} already credited)")

        if failed:
            print(BLOCKED.format(
                reason=f"{failed} note(s) could not be credited this cycle"))
            raise CommandError(
                f"{failed} note(s) could not be credited this cycle")

        if vanished or standing or unverifiable or notify_failures:
            # Withhold the heartbeat, exit 0. Restarting cannot help: the
            # condition is durable in the database and clearing it is a human
            # decision about somebody's balance. The UNBACKED line is what
            # pages. Deliberately checked BEFORE the collapsed/unresolved
            # branch so the worse incident owns the message.
            #
            # `standing` is in this condition for the same reason it is
            # printed: an unresolved unbacked credit must not let the cycle
            # look healthy on its second and every later pass.
            print(f"{len(vanished) + len(standing)} instant credit(s) are "
                  f"unbacked, {len(unverifiable)} cannot be verified and "
                  f"{notify_failures} buyer(s) could not be notified; no "
                  f"heartbeat is emitted")
            return

        if collapsed or unresolved or blind_pools:
            # Parsed notes that cannot be safely attributed remain heartbeat
            # failures: the adapter must report a distinct note, or a human
            # must resolve the recipient, before this cycle is healthy. The
            # malformed-memo disposition path is different. It has its own
            # durable/actionable BLOCKED signal, and adapter identity/amount
            # failures may be impossible to clear until a deployment changes
            # the wallet contract. They must not make a healthy loop look
            # dead to the cycle-absence watchdog.
            print(f"{collapsed} note(s) could not be told apart, "
                  f"{unresolved} had no resolvable recipient, and "
                  f"{len(blind_pools)} pool(s) hold notes this adapter cannot "
                  f"read; no heartbeat emitted")
            return

        print(HEARTBEAT.format(
            scanned=scanned, credited=credited, tuzis=total_tuzis))
