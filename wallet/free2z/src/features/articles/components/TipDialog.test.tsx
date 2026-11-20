// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { TestI18nProvider } from "@/i18n/test-provider";
import { discover } from "@/lib/api/free2z";
import type { CreatorDetail } from "@/lib/api/types";
import { TipDialog } from "./TipDialog";
let root: ReturnType<typeof createRoot>;
const alice = { username: "alice", display_name: "Alice", free2zaddr: "alice" };
function render(username = "alice") {
  root.render(
    <MemoryRouter>
      <TestI18nProvider>
        <TipDialog author={{ ...alice, username }} />
      </TestI18nProvider>
    </MemoryRouter>,
  );
}
async function click(text: string) {
  await act(async () => {
    const found = [...document.querySelectorAll("button")].find(
      (node) => node.textContent?.trim() === text,
    );
    if (!found) throw new Error(`Missing ${text}`);
    found.click();
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  root = createRoot(document.body.appendChild(document.createElement("div")));
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("never substitutes a creator returned for another author", async () => {
  vi.spyOn(discover, "creator").mockResolvedValue({
    username: "mallory",
    p2paddr: "u1mallory",
  } as CreatorDetail);
  await act(async () => render());
  await click("Tip the author");
  await click("ZECZcash wallet");
  expect(document.body.textContent).toContain(
    "destination could not be verified",
  );
  expect(document.body.textContent).not.toContain("u1mallory");
  expect(
    [...document.querySelectorAll("button")].find((node) =>
      node.textContent?.includes("Continue with ZEC"),
    )?.disabled,
  ).toBe(true);
});
it("late profile resolution cannot mutate an open article-tip snapshot", async () => {
  let resolve!: (profile: CreatorDetail) => void;
  vi.spyOn(discover, "creator").mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () => render());
  await click("Tip the author");
  await click("ZECZcash wallet");
  expect(document.body.textContent).toContain("Loading the author");
  await act(async () =>
    resolve({ username: "alice", p2paddr: "u1alice" } as CreatorDetail),
  );
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "payment details changed",
  );
  expect(document.body.textContent).not.toContain("u1alice");
  await click("Cancel");
  await click("Tip the author");
  expect(document.body.textContent).toContain("u1alice");
});
it("a response resolving after the article's author changes cannot become the new recipient", async () => {
  let resolveAlice!: (profile: CreatorDetail) => void;
  vi.spyOn(discover, "creator").mockImplementation((username) =>
    username === "alice"
      ? new Promise((done) => {
          resolveAlice = done;
        })
      : Promise.resolve({ username: "bob", p2paddr: "u1bob" } as CreatorDetail),
  );
  await act(async () => render());
  await act(async () => render("bob"));
  await act(async () =>
    resolveAlice({ username: "alice", p2paddr: "u1alice" } as CreatorDetail),
  );
  await click("Tip the author");
  await click("ZECZcash wallet");
  expect(document.body.textContent).toContain("u1bob");
  expect(document.body.textContent).not.toContain("u1alice");
});
