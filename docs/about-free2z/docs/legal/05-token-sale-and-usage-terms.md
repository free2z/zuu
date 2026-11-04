---
title: 2Z Credits and Purchases
---

2Z credits, also called tuzis, pay for things you do on Free2Z: AI tools, livestream access, comments, and boosts. Holding credits also unlocks larger upload limits. You can buy credits with Zcash and share credits with other users. See the [2Z guide](../getting-started/03-tuzis.md) for ways to use them.

## Using and sharing credits

Credits stay within Free2Z. Sharing 2Z credits, including through donations, subscriptions, and memberships, lets people share platform use and support one another. These credit transfers do not create USD creator earnings. A [direct Zcash tip](./04-crypto-contribution-guidelines.md) goes to the recipient’s own wallet and is different from sharing credits. Credits cannot be cashed out and are not shares in 2Z Inc. or a promise of investment returns.

Creator earnings come from qualifying services under a separate [creator agreement](./06-revenue-share-agreement.md). Those earnings are amounts 2Z Inc. owes in USD. Buying platform usage credits is an independent purchase.

## Buying credits with Zcash

Credits & Earnings shows a purchase estimate and the payment instructions, including the destination and memo. Review the complete purchase terms displayed in Credits & Earnings before paying. Copy the memo shown for your account into your wallet payment so Free2Z can match it correctly.

The Zcash preview includes a conservative 10% buffer. You are likely to receive more credits than the estimate if the market price holds steady. Price changes can affect the final amount; the estimate is not a guaranteed minimum or a reserved price.

Standard Zcash credit purchases currently have no Free2Z fee or spread. The credits you receive are calculated from the actual confirmed Zcash received and the market price used when Free2Z processes that confirmed payment. Your wallet's network fee is separate.

If Credits & Earnings offers a promotion, review its conditions before paying. Only offers active when your confirmed payment is processed can apply. The highest eligible offer applies; offers do not stack. An unknown or expired code does not block an otherwise valid purchase.

Credits are added after the required confirmations and matching checks. Viewing an estimate does not send Zcash or add credits. Check your credit balance after processing, and keep the payment reference so support can check receipt and credit delivery.

Purchases are subject to daily limits: $2,000 in associated account value and $10,000 in sales to one buyer. Existing balances and incoming credits count toward the account limit. Other pending purchases can also use capacity.

If payment or credit delivery is uncertain, keep your original purchase reference and contact [help@free2z.com](mailto:help@free2z.com). Check the original purchase before sending again. A received payment awaiting resolution does not disappear because credits have not yet been added.

## Refunds and your rights

Delivered or unused credits are ordinarily nonrefundable, except where applicable law, company error, or non-delivery requires a remedy. Mandatory rights, including applicable small-balance refunds and unclaimed-property rights, remain protected.

Send refund requests to [help@free2z.com](mailto:help@free2z.com) with your purchase reference and a description of the problem. Discretionary requests are reviewed manually, with a best-effort target of 60 calendar days after complete information is received. Any earlier legal or payment-processor deadline takes precedence. This target does not cancel a claim or delay a refund required sooner by law.

## Full Zcash purchase terms

Version `zec-funding-v3`, digest `99b7faa10f89fb8f41b6e91929e7819ec4eb6d6747bab4b8b2a03b15e4f7e32d`.

```text
Zcash funding method: zec-funding-v3

The quantities, ZEC amount and rates shown before sending are estimates. They do not reserve credits or lock a conversion rate. We credit the actual shielded ZEC received after the required confirmations, using a fresh recorded multi-source ZEC/USD market price when processing the payment. The credit rate is that price multiplied by (1 - the settlement spread in force when processing) and 100 2Z per USD, rounded down to four decimal places. The pricing API and billing page disclose the current settlement spread separately from the conservative estimate buffer; these parameters can change before processing and are recorded in each completed receipt. The estimate buffer does not deduct value from the actual credit. No minimum credit quantity is guaranteed by the estimate. The resulting credits use the existing three-decimal 2Z precision. Wallet network fees are separate.

Enabled global offers and any optional memo promo code are evaluated when the confirmed payment is processed. The highest eligible multiplier applies once; offers never stack, and a tie prefers the global offer. Missing, invalid, unknown, disabled or expired codes do not prevent the base purchase or an eligible global offer. Previewed offers can change or end before processing and are not guaranteed by the payment request. We record the chosen offer, multiplier and effective parameters with the receipt; later edits never reprice a completed purchase.

The required memo directs the payment to the named free2z account: {"act":"buy_2z","id":"your-username"}. No memo means no automatic credit. The memo identifies the credit recipient, not the identity of a shielded sender. Use a shielded wallet that preserves the exact memo.

We record the actual received amount, processing rate, market sources, price timestamp and resulting receipt. A stale or unavailable price defers processing until a fresh price is available. Repeated scans never credit the same note twice. Actual account and daily funding limits, inactive accounts, unknown recipients, chain revocations and operator holds can require manual resolution. Preserve the transaction and receipt references; do not resend simply because processing is delayed. Mandatory refund, consumer and unclaimed-property rights remain preserved.
```
