import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it } from "vitest";

import type { SimpleCreator } from "@/lib/api/types";
import { CreatorCard } from "./CreatorsRow";

function creator(displayName: string): SimpleCreator {
  return {
    username: displayName.toLowerCase().replaceAll(" ", "-"),
    display_name: displayName,
    bio: "",
    image: null,
    is_verified: false,
  };
}

function renderCard(displayName: string): HTMLElement {
  const markup = renderToStaticMarkup(
    <StaticRouter location="/">
      <CreatorCard creator={creator(displayName)} />
    </StaticRouter>,
  );
  const { document } = parseHTML(markup);
  const action = [...document.querySelectorAll("span")].find(
    (element) => element.textContent?.trim() === "View profile",
  );
  if (!(action instanceof document.defaultView.HTMLElement)) {
    throw new Error("creator card is missing its View profile action");
  }
  return action as unknown as HTMLElement;
}

describe("creator cards", () => {
  it.each(["Zula", "Dayana Doria Alternativa"])(
    "pins the profile action after any height consumed by %s",
    (displayName) => {
      expect(renderCard(displayName).classList.contains("mt-auto")).toBe(true);
    },
  );
});
