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

/** Resolve only the RTL locales this issue is preparing to ship. */
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
