import {
  defaultLanguage,
  useLanguage,
  type LangDict,
  type RtkI18n,
} from "@cloudflare/realtimekit-ui";
import { getCurrentLocale, type SupportedLocale } from "$lib/i18n";
import es from "$lib/locales/rtk/es.json";
import fr from "$lib/locales/rtk/fr.json";
import ptBR from "$lib/locales/rtk/pt-BR.json";

const languagePacks: Record<SupportedLocale, Partial<LangDict>> = {
  en: defaultLanguage,
  es,
  fr,
  "pt-BR": ptBR,
};

const translators: Record<SupportedLocale, RtkI18n> = {
  en: useLanguage(languagePacks.en),
  es: useLanguage(languagePacks.es),
  fr: useLanguage(languagePacks.fr),
  "pt-BR": useLanguage(languagePacks["pt-BR"]),
};

export function getRtkTranslator(
  locale: SupportedLocale = getCurrentLocale(),
): RtkI18n {
  return translators[locale];
}
