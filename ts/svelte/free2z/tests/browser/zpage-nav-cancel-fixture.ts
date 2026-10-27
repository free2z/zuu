// Mounts zpage-nav-cancel-fixture.svelte with the SAME `svelte` and
// `$app/navigation` module instances as the page it is injected into: both
// are resolved here by the dev server, exactly as the app's own imports are.
import { mount } from "svelte";

import CancelLinkNavigations from "./zpage-nav-cancel-fixture.svelte";

export function install() {
  const target = document.createElement("div");
  target.hidden = true;
  document.body.append(target);
  mount(CancelLinkNavigations, { target });
}
