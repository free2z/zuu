import { mount } from "svelte";

import PreventedPortalLink from "./fixtures/PreventedPortalLink.svelte";

export function mountPreventedPortalLink(
  eventRoot: Element,
  portal: Element,
  href: string,
) {
  if (eventRoot.contains(portal)) {
    throw new Error(
      "payment dialog portal must be outside the Svelte event root",
    );
  }
  mount(PreventedPortalLink, { target: eventRoot, props: { href } });
  const link = Array.from(eventRoot.querySelectorAll("a")).find(
    (anchor) =>
      anchor.textContent?.trim() === "Cancel delegated portal navigation",
  );
  if (!link) throw new Error("Svelte portal link did not mount");
  portal.append(link);
}
