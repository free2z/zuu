// See https://kit.svelte.dev/docs/types#app
// for information about these interfaces
declare global {
  const __PSEUDO_LOCALES__: boolean;
  const __PILOT_LOCALES__: boolean;
  namespace App {
    interface Locals {
      locale:
        | "en"
        | "es"
        | "fr"
        | "pt-BR"
        | "en-XA"
        | "en-XB"
        | "ar-XB"
        | "ar"
        | "pl"
        | "ja"
        | "hi"
        | "de";
      localePersisted: boolean;
      disabledLocales: string[];
      localeCatalogs: Record<string, unknown>;
      /**
       * The CONTENT language of the document this request is rendering, when
       * the route resolved one — an article variant's own tag, which is any
       * BCP-47 language and not one of the four above.
       *
       * Set by a content-language route's `load`; read by `hooks.server.ts`
       * for `<html lang>`. Always a canonical tag from
       * `normalizeContentLanguage`, never raw query input.
       */
      contentLanguage?: string | null;
    }
    interface Error {
      code?: number;
    }
    interface PageData {
      /**
       * Whether the request carried a `sessionid` cookie. `false` is
       * authoritative ("anonymous"); `true` only means "unresolved, do not
       * render a signed-out affordance yet". Set by `+layout.server.ts`, so
       * it is present on every page.
       */
      hasSession?: boolean;
      disabledLocales?: string[];
    }
  }

  interface HTMLElementTagNameMap {
    "rtk-meeting": HTMLElement & { meeting?: unknown };
    "rtk-participants-audio": HTMLElement & { meeting?: unknown };
  }
}

export {};
