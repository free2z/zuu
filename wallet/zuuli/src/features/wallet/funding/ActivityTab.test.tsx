import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: { username: "alice" },
  loading: false,
}));
const asyncState = vi.hoisted(() => ({
  data: [] as any[] | null,
  loading: false,
  error: null as Error | null,
  reload: vi.fn(),
}));
vi.mock("@/store/session", () => ({
  useSession: (selector: (value: typeof state) => unknown) => selector(state),
}));
vi.mock("@/hooks/useAsync", () => ({ useAsync: () => asyncState }));
vi.mock("@/lib/api/free2z", () => ({ tuzi: { transactions: vi.fn() } }));

import { ActivityTab } from "./ActivityTab";

function renderTab() {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ActivityTab />
    </MemoryRouter>,
  );
}

describe("ActivityTab purchase scope", () => {
  it("shows purchase-only empty state without broader activity claims", () => {
    asyncState.data = [];
    const markup = renderTab();
    expect(markup).toContain("No card purchases yet");
    expect(markup).toContain("available card purchase history");
    expect(markup).not.toMatch(/tips|charges|total spent|full history/i);
  });

  it("labels only the displayed purchase page and renders unknown kinds safely", () => {
    asyncState.data = [
      {
        id: 1,
        amount: 100,
        tuzis_credited: 100,
        timestamp: "2026-01-01",
        kind: "donate",
      },
      {
        id: 2,
        amount: 200,
        tuzis_credited: 200,
        timestamp: "2026-01-02",
        kind: "future-kind",
      },
    ];
    const markup = renderTab();
    expect(markup).toContain("Purchases shown");
    expect(markup).toContain("Tip");
    expect(markup).toContain("Activity");
    expect(markup).not.toMatch(/total spent|all purchases|full history/i);
    expect((markup.match(/<svg/g) ?? []).length).toBeGreaterThan(0);
  });
});
