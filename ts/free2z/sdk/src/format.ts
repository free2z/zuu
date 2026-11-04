/**
 * For **display only**: milli-2Z as 2Z with exactly three decimals, never
 * rounded — `formatMilli2z(41_500n)` is `"41.500"`. Append the unit in your
 * UI copy. Never parse the result back, store it, or send it: amounts travel
 * as integer `bigint`s whose field name carries the unit.
 */
export function formatMilli2z(milli2z: bigint): string {
  const sign = milli2z < 0n ? "-" : "";
  const abs = milli2z < 0n ? -milli2z : milli2z;
  return `${sign}${abs / 1000n}.${(abs % 1000n).toString().padStart(3, "0")}`;
}
