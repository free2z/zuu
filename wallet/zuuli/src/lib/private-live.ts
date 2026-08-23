const PRIVATE_SECRET =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizePrivateSecret(value: string): string | null {
  const secret = value.trim();
  return PRIVATE_SECRET.test(secret) ? secret.toLowerCase() : null;
}

export function privateInviteHash(secret: string): string {
  const normalized = normalizePrivateSecret(secret);
  if (!normalized) throw new Error("Private room secret is invalid");
  return `#private=${encodeURIComponent(normalized)}`;
}

export function parsePrivateInviteHash(hash: string): string | null {
  const match = /^#private=([^&]+)$/.exec(hash);
  if (!match) return null;
  try {
    return normalizePrivateSecret(decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}

export function privateInvitePath(username: string, secret: string): string {
  return `/live/${encodeURIComponent(username)}${privateInviteHash(secret)}`;
}

export function privateInviteUrl(
  origin: string,
  username: string,
  secret: string,
): string {
  const url = new URL(privateInvitePath(username, secret), origin);
  return url.toString();
}
