import { browser } from '$app/environment';

const CSRF_SECRET_LENGTH = 32;
const CSRF_ALLOWED_CHARS =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function createCSRFToken(): string {
  const bytes = new Uint8Array(CSRF_SECRET_LENGTH);
  const maxUnbiasedValue =
    Math.floor(256 / CSRF_ALLOWED_CHARS.length) * CSRF_ALLOWED_CHARS.length;
  let token = '';

  while (token.length < CSRF_SECRET_LENGTH) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < maxUnbiasedValue) {
        token += CSRF_ALLOWED_CHARS[byte % CSRF_ALLOWED_CHARS.length];
        if (token.length === CSRF_SECRET_LENGTH) break;
      }
    }
  }

  return token;
}

/**
 * Get CSRF token from cookie
 */
export function getCSRFToken(): string | null {
  if (!browser) return null;
  const match = document.cookie.match(/(?:^|; )csrftoken=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Ensure CSRF token exists by making a GET request if needed
 */
export async function ensureCSRFToken(): Promise<string | null> {
  if (!browser) return null;
  let token = getCSRFToken();
  if (token) return token;

  // Django accepts an unmasked 32-character CSRF secret when the cookie and
  // X-CSRFToken header match. Creating it on our own origin avoids making
  // every write depend on an unrelated auth GET that may be slow or offline.
  token = createCSRFToken();
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `csrftoken=${token}; Path=/; SameSite=Lax${secure}`;

  return getCSRFToken();
}

/**
 * Enhanced fetch wrapper that automatically handles CSRF tokens
 * Similar to axios interceptors in the React app
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const options = init || {};

  // Ensure credentials are included
  options.credentials = options.credentials || 'include';

  // For non-GET requests, ensure CSRF token is included
  if (options.method && options.method !== 'GET') {
    const csrfToken = await ensureCSRFToken();

    options.headers = {
      ...options.headers,
      ...(csrfToken ? { 'X-CSRFToken': csrfToken } : {}),
    };
  }

  return fetch(input, options);
}

export const API_BASE = '/api';
