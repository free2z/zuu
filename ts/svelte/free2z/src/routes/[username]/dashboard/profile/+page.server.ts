import type { PageServerLoad } from "./$types";
import { error, redirect } from "@sveltejs/kit";
import { loginDestination } from "$lib/login-destination";
import * as env from "$app/env/private";
import { requireAuthenticatedUser } from "$lib/server/backend";

export const load: PageServerLoad = async ({
  params,
  cookies,
  fetch,
  url,
  setHeaders,
}) => {
  const apiBase = env.PRIVATE_API_BASE_URL || "http://localhost:8000";

  const sessionId = cookies.get("sessionid");
  if (!sessionId) {
    throw redirect(302, loginDestination(url.pathname + url.search));
  }
  setHeaders({ "cache-control": "private, no-cache", vary: "Cookie" });

  try {
    // 401/403 -> /login; a backend 5xx, 429 or timeout -> 503.
    const creator = await requireAuthenticatedUser<any>(
      fetch,
      cookies,
      url.pathname + url.search,
    );

    if (creator.username !== params.username) {
      throw error(403, "errors.dashboard.profileForbidden", { code: 403 });
    }

    const zpagesResponse = await fetch(
      `${apiBase}/api/zpage/?mine=true&ordering=-created_at`,
      {
        headers: {
          Cookie: `sessionid=${sessionId}`,
        },
      },
    );

    const zpagesData = zpagesResponse.ok
      ? await zpagesResponse.json()
      : { results: [] };

    // `results` is one DRF page (PAGE_SIZE=12), so counting the array caps the
    // stats at 12. The `?mine=true` list injects the real totals over the whole
    // queryset (zPageListPagination in py/dj/apps/g12f/views/zpage.py); the
    // public profile route consumes them the same way.
    return {
      creator,
      zpages: zpagesData.results || [],
      publishedCount: zpagesData.published_count,
      draftCount: zpagesData.draft_count,
    };
  } catch (err: any) {
    console.error("Error loading profile dashboard:", {
      status: err?.status,
      name: err?.name,
      message: err?.message,
    });
    if (err.status) {
      throw err;
    }
    throw error(500, "errors.dashboard.profileLoadFailed", { code: 500 });
  }
};
