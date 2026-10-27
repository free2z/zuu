# Historical Zcash funding method

This retained publication preserves its original exact text and digest. It is not a current funding offer, proof of actual acceptance, or proof of payment. Historical records retain their original instructions.

Version `zec-funding-v1`, digest `0ae3c21a68c35378001006476c2c2fb45500cfe3397bad6ca00c08f199e06b88`.

```text
Zcash funding method: zec-funding-v1

This is an optional purchase of platform usage credits from 2Z Inc.; it is separate from creator USD payments and the usage-retail-v1 earnings setoff. Creating an authenticated funding intent reserves a quote and funding capacity. It does not send Zcash or prove that any credits have been issued. Review the original quoted quantity, destination, amount, memo, price and deadline before instructing your wallet to send.

The quoted sell rate is the recorded multi-source external ZEC/USD spot price multiplied by (1 - 0.10) and by 100 tuzis per USD, rounded down to four decimal places. Thus the rate supplies 90% of nominal spot-value credits per ZEC; it is not spot divided by 1.10. The quoted ZEC amount is the requested quantity divided by that exact displayed sell rate, rounded up to eight ZEC decimal places. This can add less than one zatoshi. No bonus credits are promised. The gross USD spot value and restricted nominal associated value are displayed separately and need not be equal. Your wallet's network fee is separate from the quoted amount sent to the company.

Use the exact destination and signed intent memo and send the exact quoted amount within the 30-minute send window. The memo binds the originally authenticated named buyer's instruction and recipient; it does not independently identify a shielded on-chain sender. A timely first observation by the company's receiving process preserves that original quote through later confirmations. A local wallet send timestamp alone is not proof of timely company receipt.

Actual required confirmations and source matching precede credit issuance. A captured transfer that cannot be issued because of funding limits, an unavailable writer, an expired or mismatched instruction or unverified provenance remains under recorded resolution. Preserve the original intent and receipt references; do not create a new payment instruction merely because confirmation or credit issuance is uncertain. The company must resolve actual delivery or a required refund against the original source. Mandatory refund, consumer and unclaimed-property rights and historical rights are preserved. Publication of this method does not activate an unavailable funding writer or establish worldwide legal clearance.
```
