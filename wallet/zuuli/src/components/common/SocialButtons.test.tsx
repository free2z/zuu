import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useSocialProviders", () => ({
  useSocialProviders: vi.fn(),
}));

import { useSocialProviders } from "@/hooks/useSocialProviders";
import { SocialButtons } from "./SocialButtons";

const useSocialProvidersMock = vi.mocked(useSocialProviders);
const reload = vi.fn();

function render(associate = false): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <SocialButtons associate={associate} />
    </MemoryRouter>,
  );
}

describe("SocialButtons provider availability", () => {
  beforeEach(() => {
    reload.mockReset();
    useSocialProvidersMock.mockReset();
  });

  it("shows configured X on the login surface only", () => {
    useSocialProvidersMock.mockReturnValue({
      providers: ["x"],
      loading: false,
      error: null,
      reload,
    });
    const html = render();
    expect(html).toContain("Continue with X");
    expect(html).not.toContain("Continue with Google");
    expect(html).not.toContain("Continue with GitHub");
  });

  it("shows configured X on the association surface", () => {
    useSocialProvidersMock.mockReturnValue({
      providers: ["x"],
      loading: false,
      error: null,
      reload,
    });
    expect(render(true)).toContain("Link X");
  });

  it("uses the empty product state only for valid all-unconfigured", () => {
    useSocialProvidersMock.mockReturnValue({
      providers: [],
      loading: false,
      error: null,
      reload,
    });
    expect(render()).toContain("More sign-in options coming soon.");
  });

  it("renders a retryable failure instead of roadmap copy", () => {
    useSocialProvidersMock.mockReturnValue({
      providers: [],
      loading: false,
      error: "Invalid social-provider response",
      reload,
    });
    const html = render();
    expect(html).toContain("sign-in options");
    expect(html).toContain("Retry");
    expect(html).toContain("min-tap");
    expect(html).not.toContain("coming soon");
  });

  it("lets failure override retained provider data", () => {
    useSocialProvidersMock.mockReturnValue({
      providers: ["x"],
      loading: false,
      error: "Transport unavailable",
      reload,
    });
    const html = render();
    expect(html).toContain("sign-in options.");
    expect(html).not.toContain("Continue with X");
  });

  it("keeps the failure and retry status visible while reloading", () => {
    useSocialProvidersMock.mockReturnValue({
      providers: [],
      loading: true,
      error: "Transport unavailable",
      reload,
    });
    const html = render();
    expect(html).toContain("check sign-in options.");
    expect(html).toContain("Retrying");
    expect(html).toContain("disabled");
  });
});
