import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AboutBuildCard } from ".";
import {
  ABOUT_MESSAGES,
  ABOUT_MESSAGE_KEYS,
  createAboutMessages,
} from "./copy";
import type { BuildInfo } from "@/lib/build-info";

const INFO: BuildInfo = {
  productName: "ZUULI",
  applicationId: "cash.free2z.zuuli",
  version: "1.2.3",
  build: 45,
  channel: "beta",
  platform: "android",
  sourceCommit: "abcdef0123456789abcdef0123456789abcdef01",
};

describe("About build identity", () => {
  it("renders semantic, offline build identity and a single copy action", () => {
    const markup = renderToStaticMarkup(<AboutBuildCard buildInfo={INFO} />);

    expect(markup).toContain("<h2>");
    expect(markup).toContain("<dl");
    expect(markup).toContain("<details");
    expect(markup).toContain("Build provenance");
    expect(markup).toContain("abcdef012345");
    expect(markup).toContain(INFO.sourceCommit);
    expect(markup.match(/Copy build info/g)).toHaveLength(1);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("min-h-11");
    expect(markup).toContain("break-all");
  });

  it("keeps every UI string in a complete typed message catalog", () => {
    expect(new Set(ABOUT_MESSAGE_KEYS).size).toBe(
      Object.keys(ABOUT_MESSAGES).length,
    );
    expect(ABOUT_MESSAGE_KEYS.every((key) => ABOUT_MESSAGES[key].length > 0)).toBe(
      true,
    );
  });

  it("renders expanded locale copy without clipping classes", () => {
    const expanded = createAboutMessages(
      Object.fromEntries(
        ABOUT_MESSAGE_KEYS.map((key) => [
          key,
          `Ausführlich lokalisierter Text für ${key} mit zusätzlichem Inhalt`,
        ]),
      ),
    );
    const markup = renderToStaticMarkup(
      <AboutBuildCard buildInfo={INFO} messages={expanded} />,
    );

    expect(markup).toContain("Ausführlich lokalisierter Text");
    expect(markup).toContain("break-words");
    expect(markup).toContain("whitespace-normal");
    const bannedCopyClipping = new RegExp(
      ["trun", "cate|text-elli", "psis|line-cla", "mp"].join(""),
    );
    expect(markup).not.toMatch(bannedCopyClipping);
  });
});
