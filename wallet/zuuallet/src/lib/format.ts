/** Format zatoshis as ZEC string (1 ZEC = 100,000,000 zatoshis). */
export function formatZec(zatoshis: number): string {
  const zec = zatoshis / 1e8;
  return zec.toFixed(8);
}

/** Format ZEC with currency symbol. */
export function formatZecDisplay(zatoshis: number): string {
  return `${formatZec(zatoshis)} ZEC`;
}

/** Split formatted ZEC into whole and decimal parts. */
export function splitZec(zatoshis: number): { whole: string; decimal: string } {
  const formatted = formatZec(zatoshis);
  const [whole, decimal] = formatted.split(".");
  return { whole, decimal: `.${decimal}` };
}

/** Truncate an address for display. */
export function truncateAddress(address: string, chars = 8): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

/** Format a Unix timestamp as a localized date string. */
export function formatDate(timestamp: number | null): string {
  if (!timestamp) return "Pending";
  return new Date(timestamp * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Format block height with commas. */
export function formatHeight(height: number): string {
  return height.toLocaleString();
}
