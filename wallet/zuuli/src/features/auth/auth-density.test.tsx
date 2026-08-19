import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthChooser, SelectedAuthMethod } from "./index";
import { RestoreIdentity } from "./RestoreIdentity";

function render(ui: React.ReactNode): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <MemoryRouter>{ui}</MemoryRouter>
    </TooltipProvider>,
  );
}

describe("compact auth chooser", () => {
  it("shows only neutral, concise decisions before identity is known", () => {
    const markup = render(<AuthChooser onSelect={vi.fn()} />);

    expect(markup).toContain("<h1>Log in</h1>");
    expect(markup).toContain(">Zcash</button>");
    expect(markup).toContain(">Password</button>");
    expect(markup).toContain("How it works");
    expect(markup).toContain('aria-label="Continue as guest"');
    expect(markup).not.toContain("Welcome back");
    expect(markup).not.toContain("Continue with Zcash");
    expect(markup).not.toContain("Email or username");
    expect(markup).not.toContain("More sign-in options coming soon");
  });

  it("keeps each chooser control at the 44px minimum tap target", () => {
    const markup = render(<AuthChooser onSelect={vi.fn()} />);
    const methodButtons = [...markup.matchAll(/<button[^>]+>/g)].slice(0, 2);
    expect(methodButtons).toHaveLength(2);
    for (const [button] of methodButtons) {
      expect(button).toContain("h-11");
      expect(button).toContain("min-tap");
    }

    const controls = [...markup.matchAll(/<(?:button|a)[^>]+>/g)];
    expect(controls).toHaveLength(4);
    for (const [control] of controls) expect(control).toContain("min-tap");
  });
});

describe("selected auth methods", () => {
  it("does not repeat Zcash in the selected method CTA", () => {
    const markup = render(
      <SelectedAuthMethod method="zcash" onBack={vi.fn()} />,
    );

    expect(markup).toContain("<h1>Zcash</h1>");
    expect(markup).toContain(">Continue</button>");
    expect(markup).not.toContain("Login with Zcash");
    expect(markup).not.toContain("Continue with Zcash");
    expect(markup).toContain("never leaves this device");
  });

  it("gives the icon-only method back control a name and minimum target", () => {
    const markup = render(
      <SelectedAuthMethod method="password" onBack={vi.fn()} />,
    );

    expect(markup).toContain('aria-label="Choose another login method"');
    expect(markup).toMatch(/class="[^"]*min-tap[^"]*h-11 w-11/);
    expect(markup).toContain("<h1>Password</h1>");
    expect(markup).toContain('for="f2z-username"');
    expect(markup).toContain('for="f2z-password"');
  });
});

describe("existing Zcash identity recovery", () => {
  it("keeps recovery local, masked, accessible, and explicit about signer support", () => {
    const markup = render(
      <RestoreIdentity
        restoring={false}
        error={null}
        onCancel={vi.fn()}
        onRestore={vi.fn()}
      />,
    );

    expect(markup).toContain("data-auth-restore");
    expect(markup).toContain("Use existing identity");
    expect(markup).toContain("Never sent to free2z");
    expect(markup).toContain("External wallet signing isn’t supported yet");
    expect(markup).toContain('aria-label="Back to identity choices"');
    expect(markup).toContain('autoComplete="off"');
    expect(markup).toContain('autoCapitalize="none"');
    expect(markup).toContain('autoCorrect="off"');
    expect(markup).toContain('spellcheck="false"');
    expect(markup).toContain("Restore and continue");
    expect(markup).not.toContain("Create new identity");

    for (const [control] of markup.matchAll(/<(?:button|input|textarea)[^>]+>/g)) {
      expect(control).toMatch(/(?:min-tap|h-11|min-h-20)/);
    }
  });
});
