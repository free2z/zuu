import type {
  ZPage,
  ZPageListItem,
  CreateZPageData,
  UpdateZPageData,
} from '$lib/types/zpage';
import { apiFetch, API_BASE } from './config';

// Fetch user's zPages (for dashboard)
export async function fetchUserZPages(options?: {
  published?: boolean;
  page?: number;
  limit?: number;
}): Promise<{ results: ZPageListItem[]; count: number }> {
  const params = new URLSearchParams();
  if (options?.published !== undefined) {
    params.set('is_published', String(options.published));
  }
  if (options?.page) {
    params.set('page', String(options.page));
  }
  if (options?.limit) {
    params.set('page_size', String(options.limit));
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
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
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
      console.error('Error response data:', errorData);
    } else if (errorText) {
      console.error('Error response body:', errorText);
    }

    const message =
      errorData.detail ||
      errorData.message ||
      errorData.error ||
      (errorText ? errorText.trim() : '') ||
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
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
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
      (errorText ? errorText.trim() : '') ||
      `Failed to update zPage: ${response.status}`;

    const error = new Error(message);
    (error as any).data = errorData;
    (error as any).status = response.status;
    (error as any).rawBody = errorText;
    throw error;
  }

  return response.json();
}

// Delete zPage
export async function deleteZPage(identifier: string): Promise<void> {
  const response = await apiFetch(`${API_BASE}/zpage/${identifier}/`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    throw new Error(`Failed to delete zPage: ${response.status}`);
  }
}

// Fetch public zPages by creator username
export async function fetchCreatorZPages(
  username: string,
  options?: {
    page?: number;
    limit?: number;
  }
): Promise<{ results: ZPageListItem[]; count: number }> {
  const params = new URLSearchParams();
  params.set('creator__username', username);
  params.set('is_published', 'true');

  if (options?.page) {
    params.set('page', String(options.page));
  }
  if (options?.limit) {
    params.set('page_size', String(options.limit));
  }

  const response = await apiFetch(`${API_BASE}/zpage/?${params}`);

  if (!response.ok) {
    throw new Error(`Failed to fetch creator zPages: ${response.status}`);
  }

  return response.json();
}
