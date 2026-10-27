// Phase B will make the classic nginx tier internally target this capability
// route. Keeping it distinct from /sitemap.xml makes that future mixed rollout
// fail closed: an old SvelteKit replica returns 404 here instead of its legacy
// one-file sitemap.
export { GET } from "../sitemap.xml/+server";
