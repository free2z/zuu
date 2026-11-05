import {
  defaultLanguage,
  useLanguage,
  type LangDict,
  type RtkI18n,
} from "@cloudflare/realtimekit-ui";
import { getCurrentLocale, type SupportedLocale } from "$lib/i18n";
import { getRtkCatalog } from "$lib/rtk-catalog.js";
const translators = new Map<string, { pack: unknown; translator: RtkI18n }>();
export function getRtkTranslator(
  locale: SupportedLocale = getCurrentLocale(),
): RtkI18n {
  const pack = getRtkCatalog(locale) ?? defaultLanguage;
  const cached = translators.get(locale);
  if (cached && cached.pack === pack) return cached.translator;
  const translator = useLanguage(pack as Partial<LangDict>);
  translators.set(locale, { pack, translator });
  return translator;
}
