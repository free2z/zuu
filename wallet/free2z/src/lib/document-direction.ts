// The document-direction kernel ZUULI and e2e2z use, restated for this surface.
//
// Deliberately a copy rather than an import, for the same reason
// `src/i18n/locale.ts` is: `wallet/zuuli/scripts/project-boundary.mjs` forbids
// one wallet application from importing another, and `@free2z/wallet-shared`
// exports only the sensitive-entry session — a wallet concern this surface does
// not hold. When the i18n kernel is promoted into the shared package (#906
// follow-up), this file moves with `locale.ts`.
//
// It exists here because the RTL source policy is only worth its enforcement if
// something actually flips `<html dir>`. Before #940 nothing in free2z ever
// wrote `dir`: `index.html` pinned `dir="ltr"` and no module touched it, so the
// twenty-four `rtl:` variants in this tree compiled into the bundle as CSS that
// no locale could ever select — support that was present in source and dead at
// runtime, exactly the defect #934 found in e2e2z. free2z renders articles,
// creator profiles, search results and AI output, so it is the surface where a
// bidi failure has the most untrusted text to act on.
//
// `src/i18n/index.ts` already owns `<html lang>`; this observer derives `dir`
// from it, so adding an RTL catalog is a catalog change and nothing else.

export type DocumentDirection = "ltr" | "rtl";

const RTL_LANGUAGES = new Set(["ar", "fa", "he", "ur"]);

export interface DirectionElement {
  lang: string;
  dir: string;
}

export interface DirectionObserver {
  observe(
    target: DirectionElement,
    options: { attributes: true; attributeFilter: ["lang"] },
  ): void;
  disconnect(): void;
}

export type DirectionObserverFactory = (
  onLanguageChange: () => void,
) => DirectionObserver;

/** Resolve the RTL locales this surface is preparing to ship. */
export function directionForLocale(locale: string): DocumentDirection {
  try {
    const language = new Intl.Locale(locale).language.toLowerCase();
    return RTL_LANGUAGES.has(language) ? "rtl" : "ltr";
  } catch {
    return "ltr";
  }
}

export function syncDocumentDirection(root: DirectionElement): DocumentDirection {
  const direction = directionForLocale(root.lang || "en");
  root.dir = direction;
  return direction;
}

function browserObserverFactory(
  onLanguageChange: () => void,
): DirectionObserver {
  const observer = new MutationObserver(onLanguageChange);
  return {
    observe(target, options) {
      observer.observe(target as HTMLElement, options);
    },
    disconnect() {
      observer.disconnect();
    },
  };
}

/**
 * Keep `<html dir>` derived from `<html lang>`. The locale kernel owns `lang`;
 * this narrow observer makes direction follow both bootstrap and later locale
 * changes without creating a second locale store.
 */
export function installDocumentDirection(
  root: DirectionElement = document.documentElement,
  observerFactory: DirectionObserverFactory = browserObserverFactory,
): () => void {
  const sync = () => syncDocumentDirection(root);
  sync();
  const observer = observerFactory(sync);
  observer.observe(root, { attributes: true, attributeFilter: ["lang"] });
  return () => observer.disconnect();
}
