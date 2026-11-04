import { isIP } from "node:net";

const TOKENS_PER_SECOND = 1;
const BURST_TOKENS = 10;
const MAX_CLIENTS_PER_PROCESS = 10_000;
const MAX_CLIENT_KEY_LENGTH = 64;

type Bucket = {
  tokens: number;
  updatedAtMs: number;
};

export type HistoricRootAdmissionResult =
  { admitted: true } | { admitted: false; retryAfterSeconds: number };

/**
 * A bounded per-process token bucket for historic-root resolution.
 *
 * Production SvelteKit requests carry one of two trustworthy XFF shapes. New
 * ingress traverses the same-revision sidecar, which replaces XFF with the
 * client derived from GCLB's append-only suffix. Old ingress uses the preserved
 * Service port 3000 and passes that append-only suffix directly. The bucket
 * therefore follows the visitor, not the SvelteKit pod address and not a
 * caller-controlled prefix/private header. Each
 * SvelteKit replica owns a bucket, so the fleet allowance is the configured
 * rate times the replica count; this is an abuse brake, not a distributed-DDoS
 * shield. Real creator profiles are confirmed before this bucket is spent, so
 * hover preloads and shared-NAT profile traffic cannot exhaust it. The fixed
 * client cap keeps a wide address spray from growing the Node heap without
 * bound.
 */
export class HistoricRootAdmission {
  private readonly buckets = new Map<string, Bucket>();

  admit(clientKey: string, nowMs = Date.now()): HistoricRootAdmissionResult {
    const key = normalizeClientKey(clientKey, true);
    // `historicRootClientKey()` rejects malformed ingress identity before this
    // method is called. Keep the class fail-open too so a future direct caller
    // cannot collapse malformed values into one shared denial bucket.
    if (!key) return { admitted: true };
    const existing = this.buckets.get(key);
    const elapsedSeconds = existing
      ? Math.max(0, nowMs - existing.updatedAtMs) / 1_000
      : 0;
    const available = existing
      ? Math.min(
          BURST_TOKENS,
          existing.tokens + elapsedSeconds * TOKENS_PER_SECOND,
        )
      : BURST_TOKENS;

    if (available < 1) {
      this.touch(key, { tokens: available, updatedAtMs: nowMs });
      return {
        admitted: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((1 - available) / TOKENS_PER_SECOND),
        ),
      };
    }

    this.touch(key, { tokens: available - 1, updatedAtMs: nowMs });
    return { admitted: true };
  }

  private touch(key: string, bucket: Bucket) {
    // Map insertion order is our bounded LRU. Refreshing the current key keeps
    // a legitimately active client from being evicted by old idle entries.
    this.buckets.delete(key);
    while (this.buckets.size >= MAX_CLIENTS_PER_PROCESS) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
    this.buckets.set(key, bucket);
  }
}

export function historicRootClientKey(event: {
  request: { headers?: Headers };
}): string | null {
  const forwardedFor = event.request.headers?.get("x-forwarded-for");
  if (!forwardedFor) return null;

  const addresses = forwardedFor.split(",").map((part) => part.trim());
  if (addresses.some((address) => !address)) return null;

  // Same-revision sidecar: it replaces the chain with exactly the client it
  // derived from GCLB's suffix. Direct old ingress: caller-controlled prefixes
  // may exist, but GCLB appends `<client>, <lb>` at the right, so the client is
  // always second from the right. Never trust X-Free2Z-Originating-Client here:
  // an old ingress forwards a caller-supplied copy unchanged.
  const client =
    addresses.length === 1 ? addresses[0] : addresses[addresses.length - 2];
  return normalizeClientKey(client);
}

/**
 * Preserve the trusted visitor identity through the SvelteKit API sidecar.
 *
 * The incoming helper above has already normalized either the sidecar's
 * one-entry XFF or old ingress's GCLB suffix. The sidecar is the final proxy
 * before `free2z-service`, so the synthetic two-hop chain is
 * `<visitor>, 127.0.0.1`; free2z nginx selects the second entry from the right
 * for its resolver bucket.
 */
export function historicRootForwardedFor(clientKey: string): string | null {
  const normalized = normalizeClientKey(clientKey, true);
  if (!normalized) return null;
  const address = normalized.endsWith("/64")
    ? normalized.slice(0, -3)
    : normalized;
  return `${address}, 127.0.0.1`;
}

function ipv6Hextets(value: string): number[] {
  let address = value.toLowerCase();
  const finalSegment = address.slice(address.lastIndexOf(":") + 1);
  if (finalSegment.includes(".")) {
    const octets = finalSegment.split(".").map(Number);
    const high = (octets[0] << 8) | octets[1];
    const low = (octets[2] << 8) | octets[3];
    address = `${address.slice(0, address.lastIndexOf(":") + 1)}${high.toString(16)}:${low.toString(16)}`;
  }

  const compressedAt = address.indexOf("::");
  if (compressedAt < 0) {
    return address.split(":").map((part) => Number.parseInt(part, 16));
  }

  const left = address.slice(0, compressedAt);
  const right = address.slice(compressedAt + 2);
  const leftParts = left ? left.split(":") : [];
  const rightParts = right ? right.split(":") : [];
  const omitted = 8 - leftParts.length - rightParts.length;
  return [
    ...leftParts.map((part) => Number.parseInt(part, 16)),
    ...Array.from({ length: omitted }, () => 0),
    ...rightParts.map((part) => Number.parseInt(part, 16)),
  ];
}

function normalizeClientKey(
  value: string,
  allowCanonicalPrefix = false,
): string | null {
  const key = value.trim();
  if (
    !key ||
    key.length > MAX_CLIENT_KEY_LENGTH ||
    key.includes(",") ||
    key.includes("%")
  ) {
    return null;
  }

  const address =
    allowCanonicalPrefix && key.endsWith("/64") ? key.slice(0, -3) : key;
  const version = isIP(address);
  if (version === 4) return address;
  if (version !== 6) return null;

  const hextets = ipv6Hextets(address);
  const ipv4Mapped =
    hextets.slice(0, 5).every((part) => part === 0) && hextets[5] === 0xffff;
  if (ipv4Mapped) {
    return [
      hextets[6] >> 8,
      hextets[6] & 0xff,
      hextets[7] >> 8,
      hextets[7] & 0xff,
    ].join(".");
  }

  // Match nginx's `$og_limit_key` identity contract: one residential IPv6
  // allocation is one client, even when it rotates the interface identifier.
  // Four canonical hextets represent the first 64 bits; the textual `/64`
  // suffix keeps the key unambiguous beside IPv4 values.
  return `${hextets
    .slice(0, 4)
    .map((part) => part.toString(16))
    .join(":")}::/64`;
}

export const historicRootAdmission = new HistoricRootAdmission();
