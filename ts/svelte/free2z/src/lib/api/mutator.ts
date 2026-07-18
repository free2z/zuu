import { env } from '$env/dynamic/public';
import { authStore } from '$lib/stores/auth';
import { browser } from '$app/environment';
import { ensureCSRFToken } from '$lib/api/config';

/**
 * Custom error class for API-related errors.
 * Used to provide structured information about failed API requests.
 */
export class ApiError extends Error {
  /** HTTP status code (e.g., 404, 500) */
  status: number;
  /** Error data returned from the API, often containing detailed error messages */
  data: any;

  constructor(message: string, status: number, data: any) {
    super(message);
    this.status = status;
    this.data = data;
    this.name = 'ApiError';
  }
}

/**
 * Custom fetch instance for API requests.
 * Handles baseURL, query parameters, authentication credentials, CSRF tokens,
 * and error handling with ApiError.
 * 
 * @template T - The expected return type
 * @param input - RequestInfo, URL, or an object with url and params
 * @param init - Request options, including an optional baseURL
 * @returns The parsed JSON response, or null for 204 No Content
 * @throws {ApiError} For non-OK HTTP responses
 */
export const customInstance = async <T>(
  input: RequestInfo | URL | any,
  init?: RequestInit & { baseURL?: string }
): Promise<T> => {
  let url: string;
  const baseURL =
    (init as any)?.baseURL ||
    env.PUBLIC_API_BASE_URL ||
    (!browser ? process.env.PRIVATE_API_BASE_URL : '') ||
    '';

  if (typeof input === 'string') {
    url = `${baseURL}${input}`;
  } else if (input && typeof input === 'object' && input.url) {
    url = `${baseURL}${input.url}`;

    // Handle query parameters
    if (input.params) {
      const searchParams = new URLSearchParams();
      Object.entries(input.params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          searchParams.append(key, String(value));
        }
      });
      const queryString = searchParams.toString();
      if (queryString) {
        url += `?${queryString}`;
      }
    }

    // Debug logging for popular zPages API call
    if (
      input.url?.includes('/api/zpage/') &&
      input.params?.ordering === '-f2z_score'
    ) {
      console.log('=== CUSTOM INSTANCE DEBUG ===');
      console.log('Base URL:', baseURL);
      console.log('Original URL:', input.url);
      console.log('Params:', input.params);
      console.log('Final URL:', url);
      console.log('=== END CUSTOM INSTANCE DEBUG ===');
    }

    init = { ...init, method: input.method, headers: input.headers, ...input };
    // Remove params and baseURL from init to avoid passing them in body
    delete (init as any).params;
    delete (init as any).baseURL;
  } else {
    url = input as string;
  }

  // Add default headers for authentication and CSRF
  const defaultHeaders: HeadersInit = {
    'Content-Type': 'application/json',
    ...init?.headers,
  };

  // Add CSRF token for non-GET requests
  if (init?.method && init.method !== 'GET') {
    const csrf = await ensureCSRFToken();
    if (csrf) {
      (defaultHeaders as any)['X-CSRFToken'] = csrf;
    }
  }

  // Include credentials for session-based auth
  const requestInit: RequestInit = {
    ...init,
    headers: defaultHeaders,
    credentials: 'include', // Important for Django session auth
  };

  try {
    const response = await fetch(url, requestInit);

    if (browser && authStore.handleAuthFailure(response.status)) {
      console.log('Session expired, user logged out');
    }

    if (!response.ok) {
      let errorData;
      try {
        const text = await response.text();
        try {
          errorData = JSON.parse(text);
        } catch {
          errorData = text;
        }
      } catch (e) {
        errorData = 'Unknown error';
      }
      throw new ApiError(`HTTP error! status: ${response.status}`, response.status, errorData);
    }

    if (response.status === 204) {
      // 204 No Content: return null to indicate an empty response body.
      // Callers should be prepared to handle null for operations that return 204.
      return null as T;
    }

    return response.json();
  } catch (error) {
    console.error('API request failed:', error);
    throw error;
  }
};
