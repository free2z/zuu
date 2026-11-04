/** Capped exponential retry with bounded jitter (75% to 125%). */
export function streamRetryDelay(
  retryCount: number,
  random = Math.random,
  maxDelay = 30_000,
) {
  const ceiling = Math.min(maxDelay, 1000 * 2 ** Math.min(retryCount, 10));
  return Math.min(maxDelay, Math.round(ceiling * (0.75 + random() * 0.5)));
}
