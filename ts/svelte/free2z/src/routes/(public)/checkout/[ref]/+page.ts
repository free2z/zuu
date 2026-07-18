import type { PageLoad } from "./$types";

function buyHref(method: "stripe" | "zcash", ref: string) {
  const params = new URLSearchParams({ method, ref });
  return `/buy-2z?${params.toString()}`;
}

export const load: PageLoad = ({ params }) => {
  const ref = params.ref;

  return {
    ref,
    stripeHref: buyHref("stripe", ref),
    zcashHref: buyHref("zcash", ref),
  };
};
