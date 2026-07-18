import { apiFetch } from "$lib/api/config";

export interface PublicUploadResult {
  id: number;
  url: string;
  thumbnail?: string | null;
  mime_type?: string;
  name?: string;
  title?: string;
}

export async function uploadPublicFile(
  file: File,
  title: string,
): Promise<PublicUploadResult> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("title", title.slice(0, 128));
  formData.append("access", "public");

  const response = await apiFetch("/uploads/single-public", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const message =
      (await response.text().catch(() => "")) || "Failed to upload image";
    throw new Error(message);
  }

  return (await response.json()) as PublicUploadResult;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

// Mirrors py/dj/apps/uploads/views.py::upload_limit, which nginx enforces via
// auth_request in production — this client-side check is advisory only.
export function maxUploadBytesFor(tuzis: number): number {
  if (tuzis >= 5000) {
    return 5 * GB;
  }

  if (tuzis > 0) {
    return 250 * MB;
  }

  return 5 * MB;
}

export function formatByteLimit(bytes: number): string {
  if (bytes >= GB) {
    return `${Math.round(bytes / GB)}GB`;
  }

  return `${Math.round(bytes / MB)}MB`;
}
