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
      throw error(403, "errors.dashboard.settingsForbidden", { code: 403 });
    }

    return { creator };
  } catch (err: any) {
    console.error(
      "Error loading settings:",
      err instanceof Error ? err.message : String(err),
    );
    if (err.status) {
      throw err;
    }
    throw error(500, "errors.dashboard.settingsLoadFailed", { code: 500 });
  }
};
