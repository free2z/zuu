import type {
  ZPage,
  ZPageListItem,
  CreateZPageData,
  UpdateZPageData,
} from "$lib/types/zpage";
import { apiFetch, API_BASE } from "./config";

// Fetch user's zPages (for dashboard)
export async function fetchUserZPages(options?: {
  published?: boolean;
  page?: number;
  limit?: number;
}): Promise<{ results: ZPageListItem[]; count: number }> {
  const params = new URLSearchParams();
  if (options?.published !== undefined) {
    params.set("is_published", String(options.published));
  }
  if (options?.page) {
    params.set("page", String(options.page));
  }
  if (options?.limit) {
    params.set("page_size", String(options.limit));
  }

  const response = await apiFetch(`${API_BASE}/zpage/?${params}`);

  if (!response.ok) {
    throw new Error(`Failed to fetch zPages: ${response.status}`);
  }

  return response.json();
}

// Fetch single zPage by ID or vanity URL
export async function fetchZPage(identifier: string): Promise<ZPage> {
  const response = await apiFetch(`${API_BASE}/zpage/${identifier}/`);

  if (!response.ok) {
    throw new Error(`Failed to fetch zPage: ${response.status}`);
  }

  return response.json();
}

// Create new zPage
export async function createZPage(data: CreateZPageData): Promise<ZPage> {
  const payload = {
    ...data,
    tags: data.tags ?? [],
  };

  const response = await apiFetch(`${API_BASE}/zpage/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorData: any = {};
    try {
      errorData = errorText ? JSON.parse(errorText) : {};
    } catch {
      errorData = {};
    }

    if (Object.keys(errorData).length) {
      console.error("Error response data:", errorData);
    } else if (errorText) {
      console.error("Error response body:", errorText);
    }

    const message =
      errorData.detail ||
      errorData.message ||
      errorData.error ||
      (errorText ? errorText.trim() : "") ||
      `Failed to create zPage: ${response.status}`;

    const error = new Error(message);
    (error as any).data = errorData;
    (error as any).status = response.status;
    (error as any).rawBody = errorText;
    throw error;
  }

  return response.json();
}

// Update existing zPage
export async function updateZPage(data: UpdateZPageData): Promise<ZPage> {
  // Do not include the free2zaddr in the request body — it's part of the URL/path.
  const { free2zaddr, ...rest } = data as any;
  const payload = {
    ...rest,
    tags: (rest && (rest as any).tags) ?? [],
  };

  const response = await apiFetch(`${API_BASE}/zpage/${free2zaddr}/`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorData: any = {};
    try {
      errorData = errorText ? JSON.parse(errorText) : {};
    } catch {
      errorData = {};
    }

    const message =
      errorData.detail ||
      errorData.message ||
      errorData.error ||
      (errorText ? errorText.trim() : "") ||
      `Failed to update zPage: ${response.status}`;

    const error = new Error(message);
    (error as any).data = errorData;
    (error as any).status = response.status;
    (error as any).rawBody = errorText;
    throw error;
  }

  return response.json();
}

export class ZPageDeleteError extends Error {
  status: number;
  data: unknown;

  constructor(message: string, status: number, data: unknown) {
    super(message);
    this.name = "ZPageDeleteError";
    this.status = status;
    this.data = data;
  }
}

/**
 * The CANONICAL article's validator, for a surface that never read the
 * article itself -- the My Pages dashboard, whose list rows carry no
 * page-specific `ETag`.
 *
 * The owner detail read the editor's own load makes (`?mine=true`, so a draft
 * resolves), keeping only its `ETag`. That validator always describes the
 * canonical row, whichever language the body rendered, which is exactly what a
 * `DELETE` on this URL is conditioned on.
 *
 * Two different "no validator" outcomes, kept apart on purpose (codex review):
 *
 * - `{ ok: true, etag: null }` -- the read succeeded and carried no `ETag`
 *   (an older backend, a proxy that strips it). Deleting unconditionally is
 *   then what the editor does too: a missing validator must never make
 *   deletion impossible.
 * - `{ ok: false }` -- the read itself failed (5xx during a rollout, offline,
 *   404, timeout). Falling back to an unconditional delete here would quietly
 *   switch the protection off exactly when the backend is unhealthy, so the
 *   caller must not delete until a retry succeeds.
 *
 * Reads get no default deadline from `apiFetch`, and the confirm button waits
 * on this one, so it is bounded here.
 */
export type ZPageValidatorRead =
  { ok: true; etag: string | null } | { ok: false };

export const ZPAGE_VALIDATOR_TIMEOUT_MS = 15_000;

export async function fetchZPageValidator(
  identifier: string,
): Promise<ZPageValidatorRead> {
  try {
    const response = await apiFetch(
      `${API_BASE}/zpage/${encodeURIComponent(identifier)}/?mine=true`,
      { timeoutMs: ZPAGE_VALIDATOR_TIMEOUT_MS },
    );
    // Only the header is wanted; release the (possibly large) body.
    void response.body?.cancel().catch(() => {});
    if (!response.ok) return { ok: false };
    return { ok: true, etag: response.headers.get("ETag") || null };
  } catch {
    return { ok: false };
  }
}

// Delete zPage. The ETag is optional because list responses do not carry a
// page-specific validator: the editor passes the one from its load, and the
// dashboard the one `fetchZPageValidator` read when its dialog opened.
export async function deleteZPage(
  identifier: string,
  options: { etag?: string | null } = {},
): Promise<void> {
  const response = await apiFetch(
    `${API_BASE}/zpage/${encodeURIComponent(identifier)}/`,
    {
      method: "DELETE",
      headers: options.etag ? { "If-Match": options.etag } : undefined,
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    let data: unknown = {};
    try {
      data = errorText ? JSON.parse(errorText) : {};
    } catch {
      data = errorText;
    }
    const detail =
      typeof data === "object" && data !== null && "detail" in data
        ? String((data as { detail?: unknown }).detail || "")
        : "";
    throw new ZPageDeleteError(
      detail ||
        (typeof data === "string" && data.trim()) ||
        `Failed to delete zPage: ${response.status}`,
      response.status,
      data,
    );
  }
}

// Fetch public zPages by creator username
export async function fetchCreatorZPages(
  username: string,
  options?: {
    page?: number;
    limit?: number;
  },
): Promise<{ results: ZPageListItem[]; count: number }> {
  const params = new URLSearchParams();
  params.set("creator__username", username);
  params.set("is_published", "true");

  if (options?.page) {
    params.set("page", String(options.page));
  }
  if (options?.limit) {
    params.set("page_size", String(options.limit));
  }

  const response = await apiFetch(`${API_BASE}/zpage/?${params}`);

  if (!response.ok) {
    throw new Error(`Failed to fetch creator zPages: ${response.status}`);
  }

  return response.json();
}
