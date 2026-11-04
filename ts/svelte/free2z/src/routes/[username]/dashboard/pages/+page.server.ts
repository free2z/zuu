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
  const page = url.searchParams.get("page") || "1";
  const search = url.searchParams.get("q") || "";

  // Check if user is authenticated
  const sessionId = cookies.get("sessionid");
  if (!sessionId) {
    throw redirect(302, loginDestination(url.pathname + url.search));
  }
  setHeaders({ "cache-control": "private, no-cache", vary: "Cookie" });

  try {
    // 401/403 -> /login; a backend 5xx, 429 or timeout -> 503.
    const currentUser = await requireAuthenticatedUser(
      fetch,
      cookies,
      url.pathname + url.search,
    );

    // Verify the user is accessing their own dashboard
    if (currentUser.username !== params.username) {
      throw error(403, "errors.dashboard.ownerOnly", { code: 403 });
    }

    // Fetch user's zpages (both published and drafts) using the 'mine' parameter
    const queryParams = new URLSearchParams({
      mine: "true",
      ordering: "-updated_at",
      page: page,
      page_size: "12",
    });

    if (search) {
      queryParams.set("search", search);
    }

    const zpagesResponse = await fetch(
      `${apiBase}/api/zpage/?${queryParams.toString()}`,
      {
        headers: {
          Cookie: `sessionid=${sessionId}`,
        },
      },
    );

    if (!zpagesResponse.ok) {
      console.error("Failed to fetch zpages:", zpagesResponse.status);
      return {
        zpages: [],
        count: 0,
        page: 1,
        username: currentUser.username,
      };
    }

    const zpagesData = await zpagesResponse.json();

    return {
      zpages: zpagesData.results || [],
      count: zpagesData.count || 0,
      page: parseInt(page),
      username: currentUser.username,
      search,
    };
  } catch (err: any) {
    console.error("Error loading dashboard:", err);
    // If it's already a SvelteKit error, re-throw it
    if (err.status) {
      throw err;
    }
    throw error(500, "errors.dashboard.loadFailed", { code: 500 });
  }
};
