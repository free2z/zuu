import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/useSocialProviders", () => ({
  useSocialProviders: () => ({
    providers: ["google"],
    loading: false,
    error: null,
    reload: vi.fn(),
  }),
}));

import { LinkedAccounts } from "./LinkedAccounts";

function render(user: Record<string, unknown>) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <LinkedAccounts
        user={
          {
            username: "owner",
            tuzis: 0,
            ...user,
          } as never
        }
      />
    </MemoryRouter>,
  );
}

beforeEach(() => vi.clearAllMocks());

it("shows authoritative linked state and omits the already-linked provider action", () => {
  const html = render({
    zcash_identity_linked: true,
    social_identities: ["google"],
  });
  expect(html).toContain("Zcash");
  expect(html).toContain("Linked");
  expect(html).not.toContain("Link Google");
});

it("does not claim unlinked or offer actions when identity authority is missing", () => {
  const html = render({});
  expect(html).toContain("Unable to verify");
  expect(html).not.toContain("Not linked");
  expect(html).not.toContain("Link Google");
});
