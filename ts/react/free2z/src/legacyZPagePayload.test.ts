import type { PageInterface } from "./components/PageRenderer";
import { buildLegacyZPagePayload } from "./legacyZPagePayload";

describe("buildLegacyZPagePayload", () => {
  it("removes language response metadata from legacy editor writes", () => {
    const page = {
      title: "Legacy article",
      content: "Canonical content",
      tags: [{ name: "privacy" }],
      source_language: "und",
      requested_language: "und",
      actual_language: "und",
      fallback_used: false,
      available_languages: ["und"],
      variant_is_published: true,
    } as unknown as PageInterface;

    const payload = buildLegacyZPagePayload(page, 42);

    expect(payload).toMatchObject({
      title: "Legacy article",
      content: "Canonical content",
      tags: ["privacy"],
      featured_image: 42,
      publish_at: null,
    });
    expect(payload).not.toHaveProperty("source_language");
    expect(payload).not.toHaveProperty("requested_language");
    expect(payload).not.toHaveProperty("actual_language");
    expect(payload).not.toHaveProperty("fallback_used");
    expect(payload).not.toHaveProperty("available_languages");
    expect(payload).not.toHaveProperty("variant_is_published");
    expect(page).toHaveProperty("source_language", "und");
  });
});
