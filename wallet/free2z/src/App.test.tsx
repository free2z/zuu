// @vitest-environment jsdom
import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";
import App from "./App";
import { createAppI18n } from "./i18n";

declare global {
  // React 18 requires this flag before `act` will drive a concurrent root.
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

describe("App", () => {
  it("renders the placeholder screen through the i18n kernel", async () => {
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
    expect(container.textContent).toContain(i18n.t("placeholder.heading"));
    // A missing catalog entry renders the key itself; assert we never do.
    expect(container.textContent).not.toContain("placeholder.heading");
  });
});
