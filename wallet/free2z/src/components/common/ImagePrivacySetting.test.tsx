import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ImagePrivacySetting } from "./ImagePrivacySetting";

describe("ImagePrivacySetting accessibility", () => {
  it("binds the switch to its visible name and help text", () => {
    const markup = renderToStaticMarkup(<ImagePrivacySetting />);

    expect(markup).toContain(
      'id="strict-image-privacy-label" for="strict-image-privacy"',
    );
    expect(markup).toContain(
      'aria-labelledby="strict-image-privacy-label"',
    );
    expect(markup).toContain(
      'aria-describedby="strict-image-privacy-help"',
    );
    expect(markup).toContain("Strict image privacy");
    expect(markup).toContain("Ask before loading images.");
  });
});
