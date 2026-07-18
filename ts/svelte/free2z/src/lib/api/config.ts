import { browser } from '$app/environment';

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

  try {
    // Hit a harmless GET endpoint to allow backend to set csrftoken cookie
    await fetch('/api/auth/user/', {
      method: 'GET',
      credentials: 'include',
    });
  } catch {
    // ignore network errors; we'll attempt POST anyway
  }

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
