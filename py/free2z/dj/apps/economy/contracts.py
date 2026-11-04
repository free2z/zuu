"""Canonical prospective contracts, shipped as Python alongside their consumers.

Publication does not activate the economic policy, create a service schedule
row, or constitute anyone's acceptance. Preserve published versions unchanged
once accepted; add a version and retain its resources when terms change.

This module is intentionally independent of Django and financial services.
"""
from __future__ import annotations

from hashlib import sha256
from types import MappingProxyType


def text_digest(text: str) -> str:
    """SHA-256 of the exact UTF-8 document, including its final newline."""
    return sha256(text.encode('utf-8')).hexdigest()


CREATOR_CONTRACT_VERSION = 'cc-2026-10-v1'
PAYMENT_METHOD_VERSION = 'zec-spot-2026-10-v1'
USAGE_RETAIL_VERSION = 'usage-retail-v1'

PAYMENT_METHOD_TEXT = """Payment method version: zec-spot-2026-10-v1
The initial supported payment method is a payment by 2Z from its own funds to Creator's authorized shielded Zcash address. 2Z bears network fees for that method. By accepting this agreement and submitting a disclosed payment request, Creator authorizes the following pricing method: convert the requested fixed USD obligation into Zcash using an external market spot rate obtained no more than five minutes before signing, without a 2Z exchange-rate spread. The request records the accepted agreement and exact method version and digest; this is acceptance of the stated method, not acceptance of an unseen numerical quote. 2Z records the exact rate, external source and quote time, resulting Zcash amount, USD obligation satisfied and company-funded rounding expense in the immutable signing record and payment receipt. Zcash is rounded upward when necessary to ensure that the value sent at that rate is at least the requested USD obligation; 2Z bears the excess of less than one zatoshi in value. Rounding may not reduce the USD debt satisfied or deduct additional Creator compensation. If a supported payment cannot yet be completed safely, the debt remains owed and is escalated; it is not forfeited.
"""
PAYMENT_METHOD_DIGEST = text_digest(PAYMENT_METHOD_TEXT)

CREATOR_CONTRACT_TEXT = f"""Free2Z Creator Compensation Agreement
Version: cc-2026-10-v1

1. Parties and prospective application
This agreement is between 2Z Inc. ("2Z"), operator of Free2Z, and the verified legal person or organization bound to the accepting creator account ("Creator"). The authenticated account holder accepts for that verified person and represents that they have authority to do so. Acceptance records the exact document version, digest, actor and time. Acceptance alone does not activate the new economic policy or admit a service. Covered services start only after policy activation and verified admission under an effective service schedule. Posting this document, retaining an account, an earlier KYC signature or accepting general terms does not constitute acceptance of this agreement.

This agreement applies prospectively to covered services admitted under this version. It does not convert historical usage credits into earnings, release unresolved historical claims, cancel earned compensation or replace previously accepted agreements retroactively. Historical transactions and claims retain their attributable records and applicable rights pending evidence-based reconciliation.

2. Services supplied by 2Z and Creator's contribution
For a covered service, 2Z supplies the identified platform service or access right to the purchaser as principal, administers the purchaser's order, and is responsible for the platform's promised access, billing, support and applicable refund duties. Creator supplies the licensed content, live participation or application contribution specified by the applicable service schedule to 2Z. Creator grants 2Z a nonexclusive license to host, operate, reproduce, display, distribute and deliver that contribution, and to sublicense those rights to service providers as necessary to supply the admitted service to purchasers for its promised access period. Creator retains ownership of their contribution and must possess the necessary rights and permissions, provide the described contribution, and meet the schedule's delivery obligations. Rights to a contribution continue as necessary to honor access rights already supplied to purchasers after prospective termination.

An independent seller's offer is not a covered 2Z-supplied service merely because it appears on Free2Z. Its seller, promised service, contractual responsibility and payment treatment must be identified separately before sale. This agreement does not make every third-party merchant an affiliate of 2Z or decide any transaction's regulatory classification.

3. Service schedules and admission
Every covered service must have a published, versioned service schedule describing the concrete service and contribution, creator delivery obligations, completion evidence, cancellation and refund treatment, exact USD compensation rate, and any earlier ordinary due date. The service admission records the effective schedule, this accepted agreement, the verified legal payee and attributable source evidence before the compensated service begins or purchaser value is allocated. A missing or invalid prerequisite prevents compensated admission; it does not permit 2Z to accept the service and silently retain Creator's allocation.

The applicable schedule is captured at admission. Later schedule changes apply only to later admissions after their effective time. A change in account or application ownership does not substitute a different payee for work already admitted. The schedule's published document and digest must match the schedule used by the system.

4. Usage credits and earned compensation
Tuzis are platform usage credits. Purchasing, receiving or holding usage credits alone does not earn Creator compensation. Covered service completion creates a separate, recorded USD obligation of 2Z to Creator under the captured schedule. The calculation uses the verified allocation for the delivered service and the schedule's exact rate; it does not use Creator's purchased, promotional, gifted or historical credit balance. A verified zero allocation has a recorded result of zero. Earnings are recorded as nonnegative USD amounts separately from usage credits; the interface displays the actual recorded balance, reserved amounts and amount available for a new request.

Once incurred, a verified USD obligation is payable by 2Z. It is not a discretionary reward or a redemption of Creator's usage credits. Termination, suspension or ineligibility for future work does not forfeit that obligation. A refund or correction affecting compensation requires identifiable event evidence and a contractual or legal basis, with an attributable adjustment. An adjustment may not consume compensation already reserved for a payment. Any disputed recovery beyond available compensation must be separately identified; it may not be displayed as negative earnings or erased by account termination.

5. Payment timing and requests
Payment terms reference: cc-2026-10-v1:surviving-payment-terms
The ordinary contractual due date is 30 calendar days after verified service settlement unless the captured schedule provides an earlier date. Required legal holds may delay payment only to the extent required or justified by applicable law; 2Z records the reason and reviews it, without extinguishing the debt. Creator must provide accurate legal-payee, tax and authorized payment-address information reasonably necessary to make the payment. 2Z identifies missing information promptly and provides a means to resolve it.

Creator may request any positive amount available in the recorded payable balance; no dollar minimum is imposed by this agreement. A request reserves that amount, records the authorized address and a stable request identity, and is subject to payment review. The operational target for reviewing a request is seven calendar days after necessary identity, tax and address evidence is complete. This target is not a statutory deadline, a substitute for the applicable contractual due date, or permission to forfeit compensation. Delayed reviews are escalated and explained through support.

{PAYMENT_METHOD_TEXT}

A recorded payment request is not a completed payment. 2Z records a durable signing commitment before any signing or broadcast, preserves its evidence, and reconciles uncertain outcomes before any additional action. An unknown broadcast result does not release the reservation or authorize another payment. Only verified confirmation of the recorded payment permits the corresponding USD obligation to be discharged once. Replays preserve the original amount, address, authorization and stable request identity.

6. Verification, sanctions and tax obligations
Creator provides accurate identity, authority and tax information and authorizes the requested payment address. Payment eligibility requires actual recorded review of applicable sanctions restrictions, legal-payee identity, address authority and tax treatment. Geographic infrastructure filtering alone is not complete sanctions screening. 2Z does not promise an automatic payout or infer eligibility from account status, a legacy KYC signature or a usage balance. Tax reporting and any legally required withholding depend on the payment's actual character and applicable law; they are not waived by paying in cryptocurrency.

7. Records, privacy and changes
2Z preserves the versioned acceptance, applicable schedules, service evidence, ledger adjustments and payment records necessary to substantiate obligations and resolve claims. Access and retention of personal information are governed by the applicable privacy notice and purpose-specific legal requirements. This agreement does not authorize retaining every raw identification document indefinitely or waive applicable privacy rights.

A replacement compensation agreement requires express acceptance of its exact version and digest before new services are admitted under it. Changes do not rewrite existing admissions or accrued compensation. Either party may end prospective participation, subject to completing or resolving admitted services and honoring accrued obligations and applicable purchaser remedies. Ending or revoking permission for future services does not revoke the payment-method terms in section 5 for already accrued obligations. Creator may request those obligations under the method actually accepted for the same verified payee without accepting a replacement agreement for future work; the request still requires the current authorized address and lawful payment review. Nothing in this agreement excludes nonwaivable legal rights, mandatory refunds or applicable unclaimed-property duties.

Contact and payment-review escalation: help@free2z.com.
"""
CREATOR_CONTRACT_DIGEST = text_digest(CREATOR_CONTRACT_TEXT)

USAGE_RETAIL_TEXT = """Free2Z purchase of usage credits using recorded USD earnings
Version: usage-retail-v1

2Z Inc. supplies Free2Z platform usage credits at USD 0.01 per tuzi. One tuzi is 1,000 milli-tuzis (m2Z). This purchase uses your own available, recorded USD earnings through an exact setoff against 2Z's obligation to you. It does not convert usage credits into earnings or make an ordinary credit balance payable in cash. There is no processor or network fee for this setoff.

Before confirmation, the authenticated quote identifies the exact USD amount, total m2Z, m2Z used to repay any existing platform usage debt, and remaining m2Z newly credited to your usage balance. Review that split: repaying usage debt does not add the same units to your spendable balance. The quote identifies this method's version and digest and expires after five minutes. The quote is bound to your account; a changed price, debt split or policy requires a fresh quote and confirmation before any debit.

Confirming the displayed quote authorizes only that exact purchase. The system either records the complete USD setoff, debt repayment, credit and original receipt together, or refuses without debiting your earnings. Amounts must be exact multiples of USD 0.000010000, the price of one integer m2Z; amounts are never rounded down or forfeited. Funding limits and writer availability may prevent a purchase. A retry uses the original amount, quote and request key and returns the original completed receipt even after the quote expires. Read your current balances separately from the original receipt.

Applicable delivery, refund and nonwaivable consumer rights remain. Any reversal requires attributable original-purchase and legal or contractual evidence; this method does not promise general cash redemption of usage credits or extinguish unresolved historical rights.
"""
USAGE_RETAIL_DIGEST = text_digest(USAGE_RETAIL_TEXT)

_LIVESTREAM_PPV_TEXT = """Free2Z paid livestream contribution schedule
Version: livestream-ppv-2026-10-v1
Service: livestream_ppv

Creator supplies and licenses the described live performance or presentation to 2Z, holds the required content and participant permissions, and provides the offered live access. 2Z supplies the admitted purchaser's platform session and access. The admission captures the specific meeting, unique provider participant/session, original host, purchaser, offered creator price per minute, and applicable platform fee terms before releasing a paid participant token. Ambiguous or unmatched session evidence is not a completed qualifying service.

Completion is authenticated provider evidence of the admitted participant's delivered session, matched to its original admission. Delivered duration is rounded upward to whole minutes. The platform fee is one tuzi per whole pair of those minutes, collected first. The creator session amount is the offered creator price per minute multiplied by those minutes and rounded upward to whole tuzis. The actual creator allocation is the amount collected for that creator portion after the platform fee, limited to the purchaser's available collectible credits, expressed exactly in m2Z. It is never a held amount, total session price, current host's balance or uncollected advertised amount. Creator watching their own stream creates no compensated admission. The completed receipt preserves duration, captured prices, actual collected platform and creator portions, and delivery source.

This prospective schedule applies only to a verified service admitted under cc-2026-10-v1 and this exact published version and digest. 2Z Inc. supplies the identified platform service or access as principal, owes its promised delivery, support and applicable purchaser remedies, and obtains Creator's necessary contribution rights under that agreement. A direct third-party sale, gift, donation, shared credit balance, ordinary free participation or encrypted peer-to-peer tip is not qualifying compensation under this schedule.

For verified completion, compensation is USD 0.000010000 (10,000 nano-USD) per actual allocated integer m2Z: 1,000 allocated m2Z creates USD 0.010000000 owed. This is the service-allocation formula, not a right to redeem an existing credit balance. The immutable admission identifies the original creator, verified legal payee, accepted agreement, this schedule, actual service offer and allocation terms before delivery or debit. Later ownership, price or schedule changes cannot replace that admission. A verified zero allocation records a zero result; absence of an agreement, effective schedule, licensed contribution or delivery evidence prevents admission instead of silently retaining an allocation.

The ordinary compensation due date is 30 calendar days after verified settlement, outside lawful holds. The accepted agreement governs payment review, the surviving payment method and company-paid fees and rounding. Cancelling future participation or renewal does not forfeit accrued debt or access already supplied. A delivery cancellation, refund or correction requires the original event, attributable decision and contractual or legal basis. No ordinary usage gift or processor chargeback automatically cancels compensation. An approved adjustment may not consume a payment hold or make earnings negative; an excess recovery requires a separate reviewed claim. Mandatory purchaser remedies and unresolved historical rights remain.
"""

_SDK_APPLICATION_TEXT = """Free2Z licensed application contribution schedule
Version: sdk-application-2026-10-v1
Service: sdk_application

Creator supplies the identified licensed application contribution to 2Z, including the rights and operating permissions required to deliver its actual functionality through Free2Z. 2Z supplies the admitted platform application service. The admission captures the application, original developer/payee, actual contribution and offered functionality, provider call identity, rate card, and approved customer-consented developer markup before the paid service starts. A relabeled payment to an unrelated merchant, arbitrary customer-designated recipient or unsupported contribution is not this service.

Completion requires the original call's attributable delivered result and matching durable settlement receipt. Let C be the actual provider cost in USD, P the captured platform margin as a decimal fraction, D the captured approved and customer-consented developer markup fraction, and Q the actual collected charge in integer m2Z. The developer allocation is min(floor(C*(1+P)*D/0.00001), max(Q-ceil(C/0.00001),0)) integer m2Z, as preserved in the durable developer_m2z result. Provider actual cost, rate-card and markup evidence, caps and any platform subsidy are preserved separately. Use that original allocated result, never a later application owner or accumulated credit balance. The provider portion and platform rounding are not Creator compensation. A free call, own-application use, ordinary first-party platform use, failed or undelivered call, or verified zero developer allocation earns no positive compensation under this schedule.

This prospective schedule applies only to a verified service admitted under cc-2026-10-v1 and this exact published version and digest. 2Z Inc. supplies the identified platform service or access as principal, owes its promised delivery, support and applicable purchaser remedies, and obtains Creator's necessary contribution rights under that agreement. A direct third-party sale, gift, donation, shared credit balance, ordinary free participation or encrypted peer-to-peer tip is not qualifying compensation under this schedule.

For verified completion, compensation is USD 0.000010000 (10,000 nano-USD) per actual allocated integer m2Z: 1,000 allocated m2Z creates USD 0.010000000 owed. This is the service-allocation formula, not a right to redeem an existing credit balance. The immutable admission identifies the original creator, verified legal payee, accepted agreement, this schedule, actual service offer and allocation terms before delivery or debit. Later ownership, price or schedule changes cannot replace that admission. A verified zero allocation records a zero result; absence of an agreement, effective schedule, licensed contribution or delivery evidence prevents admission instead of silently retaining an allocation.

The ordinary compensation due date is 30 calendar days after verified settlement, outside lawful holds. The accepted agreement governs payment review, the surviving payment method and company-paid fees and rounding. Cancelling future participation or renewal does not forfeit accrued debt or access already supplied. A delivery cancellation, refund or correction requires the original event, attributable decision and contractual or legal basis. No ordinary usage gift or processor chargeback automatically cancels compensation. An approved adjustment may not consume a payment hold or make earnings negative; an excess recovery requires a separate reviewed claim. Mandatory purchaser remedies and unresolved historical rights remain.
"""

_SUBSCRIPTION_ACCESS_TEXT = """Free2Z licensed membership access contribution schedule
Version: subscription-access-2026-10-v1
Service: subscription_access

Creator supplies and licenses the actual described membership content and access contribution to 2Z, has the necessary rights, and must maintain the promised access for each purchased period. 2Z supplies the identified purchaser's 30-day platform membership access/license grant and is responsible for its promised access and applicable remedies. A paid support or follow relationship alone, an empty unavailable membership or a mere expiration-field update is not evidence of the covered service. The admission captures the actual licensed offer/content/access scope, original creator/payee, subscriber, offered price and grant period before debit.

Completion is the transactional, attributable issue of that actual 30-day access/license grant and its paid settlement receipt. The allocation is exactly the paid member price actually debited under the captured and validated offer, expressed in m2Z; the current allocation assigns that paid portion to Creator without an additional platform split. Paid periods stack without wasting existing purchased access. A free follow may extend access up to 30 days but earns no USD compensation. Turning off renewal stops later charges; it does not cancel access already purchased, revoke the rights necessary to supply it, or forfeit accrued compensation. Non-delivery or loss of promised access requires the original grant and an attributable refund/correction decision under the agreement and applicable law.

This prospective schedule applies only to a verified service admitted under cc-2026-10-v1 and this exact published version and digest. 2Z Inc. supplies the identified platform service or access as principal, owes its promised delivery, support and applicable purchaser remedies, and obtains Creator's necessary contribution rights under that agreement. A direct third-party sale, gift, donation, shared credit balance, ordinary free participation or encrypted peer-to-peer tip is not qualifying compensation under this schedule.

For verified completion, compensation is USD 0.000010000 (10,000 nano-USD) per actual allocated integer m2Z: 1,000 allocated m2Z creates USD 0.010000000 owed. This is the service-allocation formula, not a right to redeem an existing credit balance. The immutable admission identifies the original creator, verified legal payee, accepted agreement, this schedule, actual service offer and allocation terms before delivery or debit. Later ownership, price or schedule changes cannot replace that admission. A verified zero allocation records a zero result; absence of an agreement, effective schedule, licensed contribution or delivery evidence prevents admission instead of silently retaining an allocation.

The ordinary compensation due date is 30 calendar days after verified settlement, outside lawful holds. The accepted agreement governs payment review, the surviving payment method and company-paid fees and rounding. Cancelling future participation or renewal does not forfeit accrued debt or access already supplied. A delivery cancellation, refund or correction requires the original event, attributable decision and contractual or legal basis. No ordinary usage gift or processor chargeback automatically cancels compensation. An approved adjustment may not consume a payment hold or make earnings negative; an excess recovery requires a separate reviewed claim. Mandatory purchaser remedies and unresolved historical rights remain.
"""

def _schedule(service, version, text):
    return MappingProxyType({
        'service': service, 'version': version, 'text': text,
        'digest': text_digest(text),
        'rate_nusd_per_allocated_m2z': 10_000,
        'contract_version': CREATOR_CONTRACT_VERSION,
    })


SERVICE_SCHEDULES = MappingProxyType({
    'livestream_ppv': _schedule('livestream_ppv', 'livestream-ppv-2026-10-v1', _LIVESTREAM_PPV_TEXT),
    'sdk_application': _schedule('sdk_application', 'sdk-application-2026-10-v1', _SDK_APPLICATION_TEXT),
    'subscription_access': _schedule('subscription_access', 'subscription-access-2026-10-v1', _SUBSCRIPTION_ACCESS_TEXT),
})

# Retain prior resources here when publishing a replacement. Existing accepted
# versions and captured admissions must remain verifiable and payable.
_CREATOR_CONTRACTS = MappingProxyType({
    CREATOR_CONTRACT_VERSION: MappingProxyType({
        'version': CREATOR_CONTRACT_VERSION, 'text': CREATOR_CONTRACT_TEXT,
        'digest': CREATOR_CONTRACT_DIGEST,
        'payment_method_version': PAYMENT_METHOD_VERSION,
        'payment_method_digest': PAYMENT_METHOD_DIGEST,
        'payment_method_text': PAYMENT_METHOD_TEXT,
    }),
})
_SCHEDULE_VERSIONS = MappingProxyType({
    (record['service'], record['version']): record
    for record in SERVICE_SCHEDULES.values()
})

# Version 1 remains byte-identical and resolvable. Publication never proved
# acceptance, but even unused prospective resources cannot be silently revised.
_RETAINED_CREATOR_CONTRACTS = _CREATOR_CONTRACTS
_RETAINED_SCHEDULE_VERSIONS = _SCHEDULE_VERSIONS
CREATOR_CONTRACT_VERSION = 'cc-2026-10-v2'
CREATOR_CONTRACT_TEXT = CREATOR_CONTRACT_TEXT.replace('cc-2026-10-v1', CREATOR_CONTRACT_VERSION).replace(
    '2. Services supplied by 2Z and Creator\'s contribution\n',
    '2. Services supplied by 2Z and Creator\'s contribution\n'
    'Only qualifying paid livestream PPV and SDK application services are covered by this version. Donations, subscriptions, memberships, following and ordinary usage-credit sharing remain closed-loop utility activities and do not create creator USD compensation under this agreement. No historical rights are cancelled by this prospective distinction.\n\n')
CREATOR_CONTRACT_DIGEST = text_digest(CREATOR_CONTRACT_TEXT)
SERVICE_SCHEDULES = MappingProxyType({
    'livestream_ppv': _schedule('livestream_ppv', 'livestream-ppv-2026-10-v2',
        _LIVESTREAM_PPV_TEXT.replace('livestream-ppv-2026-10-v1', 'livestream-ppv-2026-10-v2').replace('cc-2026-10-v1', CREATOR_CONTRACT_VERSION)),
    'sdk_application': _schedule('sdk_application', 'sdk-application-2026-10-v2',
        _SDK_APPLICATION_TEXT.replace('sdk-application-2026-10-v1', 'sdk-application-2026-10-v2').replace('cc-2026-10-v1', CREATOR_CONTRACT_VERSION)),
})
_CREATOR_CONTRACTS = MappingProxyType({**_RETAINED_CREATOR_CONTRACTS,
    CREATOR_CONTRACT_VERSION: MappingProxyType({
        'version': CREATOR_CONTRACT_VERSION, 'text': CREATOR_CONTRACT_TEXT, 'digest': CREATOR_CONTRACT_DIGEST,
        'payment_method_version': PAYMENT_METHOD_VERSION, 'payment_method_digest': PAYMENT_METHOD_DIGEST,
        'payment_method_text': PAYMENT_METHOD_TEXT,
    }),
})
_SCHEDULE_VERSIONS = MappingProxyType({**_RETAINED_SCHEDULE_VERSIONS,
    **{(record['service'], record['version']): record for record in SERVICE_SCHEDULES.values()},
})


def creator_contract(version, digest):
    """Return a retained exact document; unknown or mismatched evidence fails."""
    record = _CREATOR_CONTRACTS.get(version)
    return record if record is not None and record['digest'] == digest else None


_ZEC_FUNDING_V1_TEXT = """Zcash funding method: zec-funding-v1

This is an optional purchase of platform usage credits from 2Z Inc.; it is separate from creator USD payments and the usage-retail-v1 earnings setoff. Creating an authenticated funding intent reserves a quote and funding capacity. It does not send Zcash or prove that any credits have been issued. Review the original quoted quantity, destination, amount, memo, price and deadline before instructing your wallet to send.

The quoted sell rate is the recorded multi-source external ZEC/USD spot price multiplied by (1 - 0.10) and by 100 tuzis per USD, rounded down to four decimal places. Thus the rate supplies 90% of nominal spot-value credits per ZEC; it is not spot divided by 1.10. The quoted ZEC amount is the requested quantity divided by that exact displayed sell rate, rounded up to eight ZEC decimal places. This can add less than one zatoshi. No bonus credits are promised. The gross USD spot value and restricted nominal associated value are displayed separately and need not be equal. Your wallet's network fee is separate from the quoted amount sent to the company.

Use the exact destination and signed intent memo and send the exact quoted amount within the 30-minute send window. The memo binds the originally authenticated named buyer's instruction and recipient; it does not independently identify a shielded on-chain sender. A timely first observation by the company's receiving process preserves that original quote through later confirmations. A local wallet send timestamp alone is not proof of timely company receipt.

Actual required confirmations and source matching precede credit issuance. A captured transfer that cannot be issued because of funding limits, an unavailable writer, an expired or mismatched instruction or unverified provenance remains under recorded resolution. Preserve the original intent and receipt references; do not create a new payment instruction merely because confirmation or credit issuance is uncertain. The company must resolve actual delivery or a required refund against the original source. Mandatory refund, consumer and unclaimed-property rights and historical rights are preserved. Publication of this method does not activate an unavailable funding writer or establish worldwide legal clearance.
"""
_ZEC_FUNDING_V2_VERSION = 'zec-funding-v2'
_ZEC_FUNDING_V2_TEXT = _ZEC_FUNDING_V1_TEXT.replace('zec-funding-v1', _ZEC_FUNDING_V2_VERSION).replace(
    'signed intent memo', 'original intent matching memo').replace(
    ' and the usage-retail-v1 earnings setoff', '').replace(
    'The memo binds the originally authenticated named buyer',
    'The memo contains a stored random purchase matching token. It binds the originally authenticated named buyer')
ZEC_LIVE_FUNDING_VERSION = 'zec-funding-v3'
ZEC_LIVE_FUNDING_TEXT = """Zcash funding method: zec-funding-v3

The quantities, ZEC amount and rates shown before sending are estimates. They do not reserve credits or lock a conversion rate. We credit the actual shielded ZEC received after the required confirmations, using a fresh recorded multi-source ZEC/USD market price when processing the payment. The credit rate is that price multiplied by (1 - the settlement spread in force when processing) and 100 2Z per USD, rounded down to four decimal places. The pricing API and billing page disclose the current settlement spread separately from the conservative estimate buffer; these parameters can change before processing and are recorded in each completed receipt. The estimate buffer does not deduct value from the actual credit. No minimum credit quantity is guaranteed by the estimate. The resulting credits use the existing three-decimal 2Z precision. Wallet network fees are separate.

Enabled global offers and any optional memo promo code are evaluated when the confirmed payment is processed. The highest eligible multiplier applies once; offers never stack, and a tie prefers the global offer. Missing, invalid, unknown, disabled or expired codes do not prevent the base purchase or an eligible global offer. Previewed offers can change or end before processing and are not guaranteed by the payment request. We record the chosen offer, multiplier and effective parameters with the receipt; later edits never reprice a completed purchase.

The required memo directs the payment to the named free2z account: {"act":"buy_2z","id":"your-username"}. No memo means no automatic credit. The memo identifies the credit recipient, not the identity of a shielded sender. Use a shielded wallet that preserves the exact memo.

We record the actual received amount, processing rate, market sources, price timestamp and resulting receipt. A stale or unavailable price defers processing until a fresh price is available. Repeated scans never credit the same note twice. Actual account and daily funding limits, inactive accounts, unknown recipients, chain revocations and operator holds can require manual resolution. Preserve the transaction and receipt references; do not resend simply because processing is delayed. Mandatory refund, consumer and unclaimed-property rights remain preserved.
"""
ZEC_LIVE_FUNDING_DIGEST = text_digest(ZEC_LIVE_FUNDING_TEXT)
ZEC_FUNDING_VERSION = ZEC_LIVE_FUNDING_VERSION
ZEC_FUNDING_TEXT = ZEC_LIVE_FUNDING_TEXT
ZEC_FUNDING_DIGEST = ZEC_LIVE_FUNDING_DIGEST
_ZEC_FUNDING_METHODS = MappingProxyType({version: MappingProxyType({
    'version': version, 'text': text, 'digest': text_digest(text),
}) for version, text in (
    ('zec-funding-v1', _ZEC_FUNDING_V1_TEXT), (_ZEC_FUNDING_V2_VERSION, _ZEC_FUNDING_V2_TEXT),
    (ZEC_LIVE_FUNDING_VERSION, ZEC_LIVE_FUNDING_TEXT),
)})


def zec_funding_method(version, digest=None):
    """Resolve original terms; publication never proves a receipt or sender identity."""
    record = _ZEC_FUNDING_METHODS.get(version)
    return record if record is not None and (digest is None or digest == record['digest']) else None


def published_schedule(service, version=None):
    """Return an immutable published resource, never an arbitrary DB digest.

    A resource's presence is not proof of acceptance, an effective database
    schedule, actual delivery, activation or jurisdictional clearance.
    """
    if version is None:
        return SERVICE_SCHEDULES.get(service)
    return _SCHEDULE_VERSIONS.get((service, version))
