import { act } from "react";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("FeedbackComposer pending handoff snapshot", () => {
  let root: Root;
  let container: HTMLElement;
  let restoreGlobals: () => void;

  beforeEach(async () => {
    const { window, document } = parseHTML(
      "<!doctype html><html><body><div id='root'></div></body></html>",
    );
    const saved = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries({
      window,
      document,
      navigator: {
        ...window.navigator,
        language: "en-US",
        languages: ["en-US"],
      },
      HTMLElement: window.HTMLElement,
      HTMLFormElement: window.HTMLFormElement,
      Event: window.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value,
      });
    }
    restoreGlobals = () => {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete (globalThis as Record<string, unknown>)[name];
      }
    };
    container = document.getElementById("root") as unknown as HTMLElement;
    const { createRoot } = await import("react-dom/client");
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    restoreGlobals();
  });

  async function showPreview(overrides: {
    copyText?: (text: string) => Promise<void>;
    openExternal?: (url: string) => Promise<void>;
  }) {
    await act(async () =>
      root.render(
        <FeedbackComposer
          minimalBuildBlock="ZUULI\nVersion: 0.1.0\nBuild: 17"
          {...overrides}
        />,
      ),
    );
    const { Simulate } = await import("react-dom/test-utils");
    const github = container.querySelector(
      "input[value='github']",
    ) as HTMLInputElement;
    const description = container.querySelector(
      "#feedback-description",
    ) as HTMLTextAreaElement;
    await act(async () => {
      Simulate.change(github, { target: { checked: true } } as never);
      Simulate.change(description, {
        target: { value: "The settings screen did not open." },
      } as never);
    });
    const review = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Review report"),
    );
    await act(async () => review?.click());
  }

  it.each(["copy", "handoff"] as const)(
    "freezes the visible %s snapshot until the deferred operation settles",
    async (operation) => {
      let settle: () => void = () => {};
      const pending = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const copyText = vi.fn((_text: string) => pending);
      const openExternal = vi.fn((_url: string) => pending);
      await showPreview({ copyText, openExternal });

      const subject = container.querySelector(
        "#feedback-subject",
      ) as HTMLInputElement;
      const body = container.querySelector(
        "#feedback-body",
      ) as HTMLTextAreaElement;
      const reviewedSubject = subject.value;
      const reviewedBody = body.value;
      const action = Array.from(container.querySelectorAll("button")).find(
        (button) =>
          button.textContent?.includes(
            operation === "copy" ? "Copy reviewed report" : "Continue to chosen app",
          ),
      );

      await act(async () => {
        action?.click();
        await Promise.resolve();
      });
      expect(subject.hasAttribute("readonly")).toBe(true);
      expect(body.hasAttribute("readonly")).toBe(true);
      expect(subject.value).toBe(reviewedSubject);
      expect(body.value).toBe(reviewedBody);

      if (operation === "copy") {
        expect(copyText).toHaveBeenCalledWith(
          `Subject: ${reviewedSubject}\n\n${reviewedBody}`,
        );
      } else {
        expect(openExternal).toHaveBeenCalledTimes(1);
        const opened = new URL(openExternal.mock.calls[0][0]);
        expect(opened.searchParams.get("title")).toBe(reviewedSubject);
        expect(opened.searchParams.get("body")).toBe(reviewedBody);
      }

      await act(async () => settle());
      expect(subject.hasAttribute("readonly")).toBe(false);
      expect(body.hasAttribute("readonly")).toBe(false);
    },
  );
});
