import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FeedbackComposer } from "./FeedbackComposer";
import {
  ABOUT_MESSAGES,
  ABOUT_MESSAGE_KEYS,
  createAboutMessages,
} from "@/lib/about-copy";

describe("FeedbackComposer", () => {
  it("explains the explicit private/public choice before either is selected", () => {
    const markup = renderToStaticMarkup(
      <FeedbackComposer minimalBuildBlock="ZUULI\nVersion: 0.1.0\nBuild: 17" />,
    );
    expect(markup).toContain("Private email");
    expect(markup).toContain("Only that support inbox can read");
    expect(markup).toContain("Public GitHub issue");
    expect(markup).toContain("Anyone can read the issue and its history");
    expect(markup).toContain("does not collect logs or tracebacks");
    expect(markup).toContain("disabled");
    expect(markup).toContain("min-tap");
  });

  it("uses the complete shared About and Feedback catalog", () => {
    expect(Object.keys(ABOUT_MESSAGES).sort()).toEqual(
      [...ABOUT_MESSAGE_KEYS].sort(),
    );
    expect(
      ABOUT_MESSAGE_KEYS.filter((key) => key.startsWith("feedback")),
    ).toHaveLength(30);
  });

  it("accepts deliberately expanded locale copy without truncation classes", () => {
    const expanded = createAboutMessages(
      Object.fromEntries(
        ABOUT_MESSAGE_KEYS.map((key) => [
          key,
          `[ÅÅ] ${ABOUT_MESSAGES[key]} ${ABOUT_MESSAGES[key]}`,
        ]),
      ) as Partial<Record<(typeof ABOUT_MESSAGE_KEYS)[number], string>>,
    );
    const markup = renderToStaticMarkup(
      <FeedbackComposer
        minimalBuildBlock="ZUULI\nVersion: 0.1.0\nBuild: 17"
        messages={expanded}
      />,
    );
    for (const banned of ["trun" + "cate", "text-" + "ellipsis", "line-" + "clamp"]) {
      expect(markup).not.toContain(banned);
    }
    expect(markup).toContain("[ÅÅ] Where should this report go?");
  });
});
