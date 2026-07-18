import { env } from '$env/dynamic/private';
import { redirect } from '@sveltejs/kit';

const DEFAULT_API_BASE = 'http://localhost:8000';

type CookieReader = {
  get: (name: string) => string | undefined;
};

export type BackendUser = {
  username: string;
  p2paddr?: string | null;
  [key: string]: unknown;
};

export function getApiBase() {
  return env.PRIVATE_API_BASE_URL || DEFAULT_API_BASE;
}

export function getSessionCookie(cookies: CookieReader) {
  return cookies.get('sessionid');
}

export function getCsrfCookie(cookies: CookieReader) {
  return cookies.get('csrftoken');
}

export function buildBackendHeaders(
  sessionId: string,
  opts?: {
    csrfToken?: string;
    contentType?: string;
  }
) {
  const csrfToken = opts?.csrfToken;
  const cookieHeader = csrfToken
    ? `sessionid=${sessionId}; csrftoken=${csrfToken}`
    : `sessionid=${sessionId}`;

  const headers: Record<string, string> = {
    Cookie: cookieHeader,
  };

  if (opts?.contentType) {
    headers['Content-Type'] = opts.contentType;
  }

  if (csrfToken) {
    headers['X-CSRFToken'] = csrfToken;
  }

  return headers;
}

export async function requireAuthenticatedUser(
  fetchFn: typeof fetch,
  cookies: CookieReader
): Promise<BackendUser> {
  const sessionId = getSessionCookie(cookies);

  if (!sessionId) {
    throw redirect(302, '/?login=true');
  }

  const response = await fetchFn(`${getApiBase()}/api/auth/user/`, {
    headers: {
      Cookie: `sessionid=${sessionId}`,
    },
  });

  if (!response.ok) {
    throw redirect(302, '/?login=true');
  }

  return response.json();
}
