// Transport for the free2z API.
//
// Auth: Knox tokens. The token goes in `Authorization: Token <key>`. Knox's
// login endpoint (`/api/token/login/`) authenticates via HTTP Basic auth
// (username:password), not a JSON body — see `basicLogin` below.
//
// CORS: the free2z backend only whitelists a handful of web origins, so the
// Tauri webview's own origin is NOT allowed. On desktop we therefore route
// every request through `@tauri-apps/plugin-http` — a native Rust HTTP client
// that is not subject to browser CORS. In a plain browser we use window.fetch
// (which works from a CORS-allowed origin, or via a dev proxy).

import { API_BASE, MEDIA_BASE } from "../env";
import { isTauri } from "../platform";

const TOKEN_KEY = "zuuli.knox.token";

let inMemoryToken: string | null = null;

export function getToken(): string | null {
  if (inMemoryToken) return inMemoryToken;
  try {
    inMemoryToken = localStorage.getItem(TOKEN_KEY);
  } catch {
    /* restricted context */
  }
  return inMemoryToken;
}

export function setToken(token: string | null): void {
  inMemoryToken = token;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export function isAuthed(): boolean {
  return !!getToken();
}

/** Prefix a relative `/uploadz/...` media path with the media host. */
export function mediaUrl(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  if (/^https?:\/\//.test(path)) return path;
  return `${MEDIA_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

// The native fetch (browser or tauri-plugin-http), resolved lazily once.
type FetchLike = typeof fetch;
let fetchImpl: FetchLike | null = null;
async function getFetch(): Promise<FetchLike> {
  if (fetchImpl) return fetchImpl;
  // `tauri dev` is served by the Vite dev server, whose proxy forwards /api and
  // /uploadz to the backend (same-origin localhost:1423 → backend, no CORS). Use
  // window.fetch there so that proxy is honored. Only production builds (no dev
  // server, absolute API_BASE like https://free2z.cash) need tauri-plugin-http
  // to dodge browser CORS from the webview's own origin.
  const isDev = Boolean(
    (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV,
  );
  const useNativeHttp = isTauri() && !isDev;
  if (useNativeHttp) {
    const mod = await import("@tauri-apps/plugin-http");
    fetchImpl = mod.fetch as unknown as FetchLike;
  } else {
    fetchImpl = window.fetch.bind(window);
  }
  return fetchImpl;
}

interface RequestOpts {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  cache?: RequestCache;
  /** Skip the auth header even if a token exists. */
  anonymous?: boolean;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOpts["query"]): string {
  const abs = path.startsWith("http") ? path : `${API_BASE}${path}`;
  // When API_BASE is "" (dev proxy), `abs` is a same-origin relative path;
  // resolve it against the current origin so URLSearchParams works.
  const base =
    typeof window !== "undefined" ? window.location.origin : "http://localhost";
  const url = new URL(abs, base);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/** Core request. Returns parsed JSON (or the raw string for bare responses). */
export async function request<T>(
  path: string,
  opts: RequestOpts = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...opts.headers,
  };
  if (opts.body !== undefined && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const token = getToken();
  if (token && !opts.anonymous && !headers["Authorization"]) {
    headers["Authorization"] = `Token ${token}`;
  }

  const doFetch = await getFetch();
  const res = await doFetch(buildUrl(path, opts.query), {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
    cache: opts.cache,
  });

  const text = await res.text();
  const data = text ? safeJson(text) : undefined;

  if (!res.ok) {
    throw new ApiError(res.status, errorMessage(res.status, data), data);
  }
  return data as T;
}

/** Knox login: HTTP Basic auth against /api/token/login/ → { token, expiry }. */
export async function basicLogin(
  username: string,
  password: string,
): Promise<string> {
  const basic = btoa(`${username}:${password}`);
  const res = await request<{ token: string; expiry?: string }>(
    "/api/token/login/",
    { method: "POST", anonymous: true, headers: { Authorization: `Basic ${basic}` } },
  );
  setToken(res.token);
  return res.token;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessage(status: number, data: unknown): string {
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (typeof d.detail === "string") return d.detail;
    if (typeof d.error === "string") return d.error;
  }
  if (typeof data === "string" && data.length < 200) return data;
  if (status === 402) return "Not enough 2Zs.";
  return `Request failed (${status})`;
}
