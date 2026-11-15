import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("Tailwind class overrides", () => {
  it("keeps caller overrides for v4 spacing, radius, shadow, and ring utilities", () => {
    expect(cn("p-4 rounded-sm shadow-xs focus-visible:ring-2", "p-6 rounded-lg shadow-md focus-visible:ring-4"))
      .toBe("p-6 rounded-lg shadow-md focus-visible:ring-4");
    expect(cn("bg-primary text-foreground", "bg-secondary text-muted-foreground"))
      .toBe("bg-secondary text-muted-foreground");
  });
});
