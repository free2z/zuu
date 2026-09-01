import { describe, expect, it } from "vitest";
import {
  directionForLocale,
  installDocumentDirection,
  syncDocumentDirection,
  type DirectionElement,
  type DirectionObserver,
} from "./document-direction";

describe("document locale direction", () => {
  it.each(["ar", "ar-EG", "fa-IR", "he-IL", "ur-PK"])(
    "maps %s to RTL",
    (locale) => expect(directionForLocale(locale)).toBe("rtl"),
  );

  it.each(["en", "es-419", "fr-FR", "", "not_a_locale"])(
    "fails %j safely to LTR",
    (locale) => expect(directionForLocale(locale)).toBe("ltr"),
  );

  it("writes the direction derived from the current language", () => {
    const root = { lang: "fa-AF", dir: "ltr" };
    expect(syncDocumentDirection(root)).toBe("rtl");
    expect(root).toEqual({ lang: "fa-AF", dir: "rtl" });
  });

  it("observes only lang and re-syncs every locale change", () => {
    const root: DirectionElement = { lang: "en", dir: "rtl" };
    let callback: (() => void) | undefined;
    let observed:
      | {
          target: DirectionElement;
          options: { attributes: true; attributeFilter: ["lang"] };
        }
      | undefined;
    let disconnected = false;
    const observer: DirectionObserver = {
      observe(target, options) {
        observed = { target, options };
      },
      disconnect() {
        disconnected = true;
      },
    };

    const stop = installDocumentDirection(root, (next) => {
      callback = next;
      return observer;
    });

    expect(root.dir).toBe("ltr");
    expect(observed).toEqual({
      target: root,
      options: { attributes: true, attributeFilter: ["lang"] },
    });

    root.lang = "ar-EG";
    callback?.();
    expect(root.dir).toBe("rtl");

    root.lang = "fr";
    callback?.();
    expect(root.dir).toBe("ltr");

    stop();
    expect(disconnected).toBe(true);
  });
});
