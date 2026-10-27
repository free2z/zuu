import type { PageServerLoad } from "./$types";
import { error, redirect } from "@sveltejs/kit";
import { loginDestination } from "$lib/login-destination";
import { requireAuthenticatedUser } from "$lib/server/backend";

export const load: PageServerLoad = async ({
  params,
  cookies,
  fetch,
  url,
  setHeaders,
}) => {
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

    return {
      username: currentUser.username,
    };
  } catch (err: any) {
    console.error("Error loading dashboard:", err);
    if (err.status) {
      throw err;
    }
    throw error(500, "errors.dashboard.loadFailed", { code: 500 });
  }
};
