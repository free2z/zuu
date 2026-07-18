import { error } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, request, fetch }) => {
  try {
    const { uuid } = params;
    const cookie = request?.headers?.get("cookie");
    const apiBase = env.PRIVATE_API_BASE_URL || "";
    const headers = cookie ? { cookie } : undefined;

    let response = await fetch(`${apiBase}/api/comments/${uuid}/`, { headers });

    if (!response.ok) {
      throw error(404, { message: "Conversation not found", code: 404 });
    }

    const selectedComment = await response.json();
    let comment = selectedComment;
    const visited = new Set<string>();

    while (comment.parent && !visited.has(comment.uuid)) {
      visited.add(comment.uuid);
      response = await fetch(`${apiBase}/api/comments/${comment.parent}/`, {
        headers,
      });
      if (!response.ok) break;
      comment = await response.json();
    }

    return {
      comment,
      focusUuid: selectedComment.uuid,
    };
  } catch (err) {
    console.error("Failed to load conversation", err);
    throw error(404, { message: "Conversation not found", code: 404 });
  }
};
