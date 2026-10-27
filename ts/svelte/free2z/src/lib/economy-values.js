/** Convert a nonnegative USD decimal to the ledger's exact nine places.
 * @param {unknown} value */
export function usdFixed(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)(\.\d{1,9})?$/.test(value)) {
    throw new Error(
      "Enter a nonnegative USD amount with at most nine decimal places.",
    );
  }
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${fraction.padEnd(9, "0")}`;
}

/** Never round a positive subcent obligation to zero or use floating point.
 * @param {string} value */
export function formatUsd(value, locale = "en") {
  const [whole, fraction] = usdFixed(value).split(".");
  const significant = fraction.replace(/0+$/, "").padEnd(2, "0");
  const decimal =
    new Intl.NumberFormat(locale)
      .formatToParts(1.1)
      .find((part) => part.type === "decimal")?.value || ".";
  return `$${BigInt(whole).toLocaleString(locale)}${decimal}${significant} USD`;
}

/** @param {string} value */
export function positiveUsd(value) {
  return usdFixed(value) !== "0.000000000";
}

/** Milli-2Z integer wire values are exact, including amounts beyond JS integers.
 * @param {string} value */
export function formatUsageMilli(value, locale = "en") {
  if (typeof value !== "string" || !/^\d+$/.test(value))
    throw new Error("Invalid usage amount.");
  const amount = BigInt(value);
  const fraction = String(amount % 1000n)
    .padStart(3, "0")
    .replace(/0+$/, "");
  const decimal =
    new Intl.NumberFormat(locale)
      .formatToParts(1.1)
      .find((part) => part.type === "decimal")?.value || ".";
  return `${(amount / 1000n).toLocaleString(locale)}${fraction ? decimal + fraction : ""} 2Z`;
}

/** Original issued total can repay usage debt before adding spendable credits.
 * @param {unknown} value @param {string} total
 * @returns {{added: string, debtRepaid: string} | null} */
export function creditedAllocation(value, total) {
  if (!value || typeof value !== "object" || !/^\d+$/.test(total)) return null;
  const row = /** @type {Record<string, unknown>} */ (value);
  const added = row.usage_credited_m2z;
  const debtRepaid = row.usage_debt_repaid_m2z;
  if (
    typeof added !== "string" ||
    typeof debtRepaid !== "string" ||
    !/^\d+$/.test(added) ||
    !/^\d+$/.test(debtRepaid)
  )
    return null;
  return BigInt(added) + BigInt(debtRepaid) === BigInt(total)
    ? { added, debtRepaid }
    : null;
}
