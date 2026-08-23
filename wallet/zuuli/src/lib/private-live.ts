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

/**
 * Choose a shareable invite for the current runtime.
 *
 * Browser builds keep the capability in a fragment so it is not sent in the
 * initial HTTP request. Packaged Tauri origins are internal-only, so native
 * builds use free2z's existing public `/{username}/private/{secret}` route.
 * There is no native live-link registration to pretend otherwise.
 */
export function privateInviteDisplayUrl({
  appOrigin,
  publicWebBase,
  native,
  username,
  secret,
}: {
  appOrigin: string;
  publicWebBase: string;
  native: boolean;
  username: string;
  secret: string;
}): string | null {
  if (!native) return privateInviteUrl(appOrigin, username, secret);

  const normalized = normalizePrivateSecret(secret);
  if (!normalized) throw new Error("Private room secret is invalid");
  try {
    const url = new URL(publicWebBase);
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !hostname ||
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]"
    ) {
      return null;
    }
    url.pathname = `/${encodeURIComponent(username)}/private/${encodeURIComponent(normalized)}`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}
