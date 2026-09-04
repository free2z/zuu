// @vitest-environment jsdom
import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createAppI18n } from "./i18n";

const controls = vi.hoisted(() => ({ mounted: vi.fn() }));

// The screen itself has its own tests. What this file proves is that the app
// shell mounts it through the i18n kernel — the two halves of #909's scaffold
// and #904's port meeting.
vi.mock("./features/messages", () => ({
  default: () => {
    controls.mounted();
    return <p data-messages-feature>messages</p>;
  },
}));

const { default: App } = await import("./App");

declare global {
  // React 18 requires this flag before `act` will drive a concurrent root.
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

describe("App", () => {
  it("renders the messaging surface through the i18n kernel", async () => {
    const i18n = await createAppI18n("en");
    const container = document.createElement("div");
    document.body.append(container);
    await act(async () => {
      createRoot(container).render(
        <StrictMode>
          <I18nextProvider i18n={i18n}>
            <App />
          </I18nextProvider>
        </StrictMode>,
      );
    });
    expect(controls.mounted).toHaveBeenCalled();
    expect(container.textContent).toContain(i18n.t("app.tagline"));
    // A missing catalog entry renders the key itself; assert we never do.
    expect(container.textContent).not.toContain("app.tagline");
  });
});
