import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ params, url }) => {
  const username = encodeURIComponent(params.username);
  const slug = encodeURIComponent(params.slug);

  redirect(301, `/${username}/${slug}${url.search}`);
};
