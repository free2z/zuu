/** Round up to a whole zatoshi so an unchanged rate covers the selected 2Z. */
export function zecAmountForPurchase(quantity: number, rate: number): number {
  if (
    !Number.isFinite(quantity) ||
    quantity < 1 ||
    !Number.isFinite(rate) ||
    rate <= 0
  )
    return NaN;
  const zatoshi = Math.ceil((quantity / rate) * 100_000_000);
  return Number.isSafeInteger(zatoshi) && zatoshi > 0
    ? zatoshi / 100_000_000
    : NaN;
}

/** A 2Z purchase must carry its account-attribution memo in a shielded payment. */
export function buildZcashPurchaseUri(
  address: string,
  amount: number,
  memo: string,
): string {
  if (
    !/^(?:u1|zs1)[a-z0-9]+$/.test(address) ||
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    return "";
  }
  const amountText = amount.toFixed(8);
  if (!/^\d+\.\d{8}$/.test(amountText) || Number(amountText) <= 0) return "";

  try {
    const purchase = JSON.parse(memo);
    if (
      purchase?.act !== "buy_2z" ||
      typeof purchase.id !== "string" ||
      !purchase.id.trim()
    )
      return "";
    const bytes = new TextEncoder().encode(memo);
    if (bytes.length > 512) return "";
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const memo64 = btoa(binary)
      .replaceAll("=", "")
      .replaceAll("+", "-")
      .replaceAll("/", "_");
    if (!memo64) return "";
    return `zcash:${address}?amount=${amountText}&memo=${memo64}`;
  } catch {
    // Never hand off a memo-less payment when attribution cannot be encoded.
    return "";
  }
}
