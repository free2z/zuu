import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { Livestream } from "@/lib/api/types";
import { StreamCard } from "./StreamCard";

function stream(participants: number | null): Livestream {
  return {
    id: "stream",
    username: "alice",
    creator: {
      username: "alice",
      free2zaddr: "alice",
      display_name: "Alice",
    },
    title: "Truthful stream",
    kind: "broadcast",
    live: true,
    participants,
    price_tuzis: 0,
  };
}

function render(participants: number | null): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <StreamCard stream={stream(participants)} />
    </MemoryRouter>,
  );
}

describe("StreamCard participant count accessibility", () => {
  it("renders and announces an unavailable count without zero-like copy", () => {
    const markup = render(null);
    expect(markup).toContain("Unavailable");
    expect(markup).toContain(
      'aria-label="Truthful stream by Alice — live now, Participant count unavailable"',
    );
    expect(markup).not.toContain("0 watching");
    expect(markup).not.toContain("1 watching");
  });

  it("keeps a real zero visibly and accessibly distinct from unknown", () => {
    const markup = render(0);
    expect(markup).toContain(
      'aria-label="Truthful stream by Alice — live now, 0 people watching"',
    );
    expect(markup).toMatch(/<span class="bidi-number tabular-nums">0<\/span>/);
    expect(markup).not.toContain("Unavailable");
  });
});
