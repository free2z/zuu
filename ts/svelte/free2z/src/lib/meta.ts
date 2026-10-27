import * as env from "$app/env/public";
import type { ZPageDetail } from "$lib/api/f2z.schemas";
import { t, type TranslationFunction } from "$lib/i18n";
import { defineMessage, translateMessage } from "$lib/i18n-message";
import { selectCanonicalUrl } from "$lib/canonical-url.js";
import {
  articleCanonicalHref,
  articleLanguageAlternates,
  explicitArticleLanguage,
  normalizeContentLanguage,
} from "$lib/zpage-language.js";
import { plainSocialCardSummaryText } from "$lib/social-card-text";
import { zpageCanonicalPath } from "$lib/zpage-path.js";
import { buildVideoObjects } from "$lib/utils/embedded-media";
import {
  DEFAULT_ROBOTS,
  DEFAULT_SOCIAL_IMAGE,
  DEFAULT_SOCIAL_IMAGE_ALT,
  DEFAULT_SOCIAL_IMAGE_HEIGHT,
  DEFAULT_SOCIAL_IMAGE_WIDTH,
  CANONICAL_ORIGIN,
  FACEBOOK_APP_ID,
  SITE_NAME,
  TWITTER_CREATOR,
  TWITTER_SITE,
  compactText,
  escapeJsonForHtml,
  toAbsoluteUrl,
} from "$lib/seo";

const configuredCanonicalBaseUrl =
  env.PUBLIC_CANONICAL_BASE_URL?.replace(/\/$/, "") || "";
const canonicalBaseUrl = configuredCanonicalBaseUrl || CANONICAL_ORIGIN;

const META_MESSAGES = {
  articleDescriptionFallback: defineMessage(
    "meta.articleDescriptionFallback",
    "Read this article and discover more independent creators on Free2Z.",
  ),
  featuredImageAlt: defineMessage(
    "meta.featuredImageAlt",
    "Featured image for {title}",
  ),
  // Wording copied from `crawler.SUBSCRIBER_ONLY_DESCRIPTION` in
  // py/dj/apps/g12f/views/crawler.py so retiring that tier does not change the
  // card. It describes access, never a price — 2Z are platform credits.
  subscriberOnlyDescription: defineMessage(
    "meta.subscriberOnlyDescription",
    "This page is available to subscribers on Free2Z.",
  ),
};

export interface ZPageMetaOptions {
  translate?: TranslationFunction;
  loading?: boolean;
}

type MetaTag = {
  tag: "meta";
  props: { name?: string; property?: string; content: string };
};

export type ZPageLanguageAlternate = { hreflang: string; href: string };

export interface ZPageMetaResult {
  title: string;
  canonical?: string;
  /**
   * `rel="alternate"` links for the article's language variants, including the
   * closing `x-default`. Empty when we do not own the canonical.
   */
  alternates: ZPageLanguageAlternate[];
  tags: MetaTag[];
  jsonLd?: Record<string, unknown>;
  jsonLdString?: string | null;
}

// The one indexable URL for a zPage is `/{username}/{vanity or free2zaddr}` —
// the shape the sitemap publishes and the only one `[username]/[vanity]`
// answers with a 200. Django computes the same thing in
// `zPage.get_public_url()`, but that is NOT serialized to API clients, so it is
// re-derived here; see  for folding it into the payload instead.
//
// Deliberately built from `creator.username` + `vanity`/`free2zaddr` rather
// than from the serialized `get_url` field: `get_url` is the legacy
// `/{username}/zpage/{slug}` shape that `[username]/zpage/[slug]` 301s away,
// and a canonical pointing at a redirect is a weak-to-ignored signal.
function buildCanonicalPath(article?: ZPageDetail | null) {
  if (!article) return null;
  const canonicalPath = zpageCanonicalPath(article);
  if (canonicalPath) return canonicalPath;
  if (article.get_url) {
    try {
      // Last resort when the payload lacks a username or any slug: strip the
      // legacy `zpage` segment out of the middle of `/{username}/zpage/{slug}`
      // so even the fallback lands on the 200 rather than the 301.
      const legacyPath = new URL(article.get_url, canonicalBaseUrl).pathname;
      const legacyMatch = /^\/([^/]+)\/zpage\/([^/]+)$/.exec(legacyPath);
      if (!legacyMatch) return null;
      return zpageCanonicalPath({
        creator: { username: decodeURIComponent(legacyMatch[1]) },
        free2zaddr: decodeURIComponent(legacyMatch[2]),
      });
    } catch {
      return null;
    }
  }
  return null;
}

function buildCanonicalUrl(path?: string | null) {
  if (!path) return undefined;
  return toAbsoluteUrl(path, canonicalBaseUrl);
}

function buildDescription(
  article: ZPageDetail | null | undefined,
  translator: TranslationFunction,
) {
  // A subscriber-only page is publicly *linkable* but its body is paywalled, so
  // the card must never fall back to `content` — the same rule
  // `crawler._card_description()` enforces on the Django side, and the stricter
  // of the two behaviours, so it is the one that survives ( phase 3).
  //
  // Today the API already redacts `content` for gated pages, but only for
  // requests that are not the author's: SSR forwards the reader's cookie, so an
  // author viewing their own gated page gets the real body back and, without
  // this guard, would stamp paywalled copy into og:/twitter:description. Not
  // reachable by a crawler (crawlers are anonymous), which is exactly why it
  // would sit here unnoticed. An author's own `description` is still used —
  // they wrote it for the card.
  if (article?.is_subscriber_only && !article?.description) {
    return translateMessage(
      META_MESSAGES.subscriberOnlyDescription,
      undefined,
      translator,
    );
  }
  return compactText(
    article?.description || article?.content,
    translateMessage(
      META_MESSAGES.articleDescriptionFallback,
      undefined,
      translator,
    ),
  );
}

// Translation edits do not update the parent article timestamp. Fingerprint
// the selected public text so a changed translation gets a fresh image URL.
// This is a cache revision, not a security/integrity token.
function cardTextRevision(article: ZPageDetail): string {
  // Public cards use body text only when no description exists. An owner's
  // authenticated page may contain a paywalled body that the public card never
  // receives, so it must not influence public metadata or its cache revision.
  const subtitle =
    article.description ||
    (article.is_subscriber_only ? "" : article.content || "");
  const text = JSON.stringify([
    plainSocialCardSummaryText(article.title, 125),
    plainSocialCardSummaryText(subtitle, 190),
  ]);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index++) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function buildImage(article?: ZPageDetail | null) {
  const identifier = article?.vanity || article?.free2zaddr;
  if (!identifier) return toAbsoluteUrl(DEFAULT_SOCIAL_IMAGE, canonicalBaseUrl);
  const version = encodeURIComponent(article.updated_at || "1");
  const language = explicitArticleLanguage(article.actual_language);
  const languageQuery = language ? `&lang=${encodeURIComponent(language)}` : "";
  return toAbsoluteUrl(
    `/og/zpage/${encodeURIComponent(identifier)}.png?v=${version}&renderer=5&text=${cardTextRevision(article)}${languageQuery}`,
    canonicalBaseUrl,
  );
}

// `og:locale` wants `language_TERRITORY`, not a bare language subtag — Facebook
// matches against a fixed list and drops anything else. Production currently
// serves `og:locale` content="und" on most of the back catalogue, because `und`
// is the legacy `SourceLanguageEnum` member for pages that predate the
// multilingual work and the old code passed `actual_language` straight through;
// `en`/`es`/`fr` were equally unusable. Harmless while the Django card tier is
// what unfurlers see (it emits no `og:locale` at all), a defect the moment SSR
// is the only tier — which is what this PR certifies.
//
// an article can be served in any content language, so this table
// being the four UI locales meant a published `zh-Hans` article unfurled as
// `og:locale="en_US"` beside a Chinese `og:title` — the last reader-path
// UI-locale lookup. The four stay as curated answers; anything else is derived
// from CLDR's likely region (`zh-Hans` -> `zh_CN`, `zh-Hant` -> `zh_TW`, `ja` ->
// `ja_JP`), and when no region can be derived the tag is OMITTED. Facebook
// matches `og:locale` against a fixed list and ignores what it does not know,
// so an absent tag costs nothing; a tag asserting the wrong language is a claim
// about the content that is simply false.
const OG_LOCALES: Record<string, string> = {
  en: "en_US",
  es: "es_ES",
  fr: "fr_FR",
  "pt-BR": "pt_BR",
};
const DEFAULT_OG_LOCALE = OG_LOCALES.en;

function ogLocale(article?: ZPageDetail | null): string | undefined {
  const tag = normalizeContentLanguage((article as any)?.actual_language);
  // No language at all (`und`, a NULL source, the pre-multilingual back
  // catalogue): keep the historical default rather than dropping a tag that
  // has always been there for those pages.
  if (!tag) return DEFAULT_OG_LOCALE;
  const curated = OG_LOCALES[tag];
  if (curated) return curated;
  try {
    const maximized = new Intl.Locale(tag).maximize();
    if (maximized.language && maximized.region) {
      return `${maximized.language}_${maximized.region}`;
    }
  } catch {
    // Not a locale this runtime can expand; say nothing.
  }
  return undefined;
}

function buildJsonLd(
  article: ZPageDetail | null | undefined,
  canonicalUrl: string | undefined,
  description: string,
  imageUrl: string,
) {
  if (!article?.title || !article.creator?.username || !article.created_at)
    return undefined;

  const authorName = article.creator.username;
  const authorUrl = `${canonicalBaseUrl}/${encodeURIComponent(authorName)}`;
  // One VideoObject per PUBLIC embedded video that actually has a poster
  // frame; `[]` for every page that embeds none, which is almost all of
  // them. See buildVideoObjects for why each omission rule exists.
  const videos = buildVideoObjects((article as any).media, {
    canonicalBaseUrl,
    canonicalUrl,
    pageTitle: article.title,
    pageDescription: description,
  });
  const articleNode = {
    "@type": "Article",
    "@id": `${canonicalUrl}#article`,
    headline: article.title,
    description,
    image: [imageUrl],
    author: { "@type": "Person", name: authorName, url: authorUrl },
    publisher: {
      "@type": "Organization",
      "@id": `${canonicalBaseUrl}/#organization`,
      name: SITE_NAME,
    },
    datePublished:
      article.published_at || article.publish_at || article.created_at,
    dateModified: article.updated_at || article.created_at,
    url: canonicalUrl,
    mainEntityOfPage: canonicalUrl
      ? { "@type": "WebPage", "@id": canonicalUrl }
      : undefined,
    keywords: article.tags?.join(", ") || undefined,
    articleSection: article.category || undefined,
    isAccessibleForFree: !article.is_subscriber_only,
    inLanguage:
      (article as any).actual_language ||
      (article as any).source_language ||
      "en",
    // Present only when there is something to point at, so a page with no
    // video emits byte-for-byte the object it always did.
    ...(videos.length
      ? { video: videos.map((node) => ({ "@id": node["@id"] })) }
      : {}),
  };

  if (!videos.length) {
    // The historical shape: a single flat Article node. Kept exactly as it
    // was rather than always wrapping in a @graph, because every page
    // without a video would otherwise get a structurally different (if
    // equivalent) block for no benefit.
    return { "@context": "https://schema.org", ...articleNode };
  }

  return {
    "@context": "https://schema.org",
    "@graph": [articleNode, ...videos],
  };
}

export { escapeJsonForHtml };

export function buildZPageMeta(
  article?: ZPageDetail | null,
  options: ZPageMetaOptions = {},
): ZPageMetaResult {
  const translator = options.translate ?? t;
  const title = article?.title ? `${article.title} | ${SITE_NAME}` : SITE_NAME;
  const headTitle = options.loading
    ? translator("article.loading", "Loading story…")
    : title;
  const description = buildDescription(article, translator);
  const baseCanonicalUrl = buildCanonicalUrl(buildCanonicalPath(article));
  // The variant list is what makes the canonical honest: the query-free URL
  // belongs to whichever language a default negotiation resolves to, which is
  // not always the source. Same answer feeds the hreflang set below, so the
  // two can never disagree.
  const availableLanguages = (article as any)?.available_languages;
  const localizedCanonicalUrl = baseCanonicalUrl
    ? articleCanonicalHref(
        baseCanonicalUrl,
        (article as any)?.actual_language,
        (article as any)?.source_language,
        availableLanguages,
      )
    : undefined;
  const canonicalUrl = selectCanonicalUrl(
    article?.canonical_url,
    localizedCanonicalUrl,
  );
  // hreflang is only meaningful on a page that is its own canonical. When the
  // creator has pointed the canonical at another site, advertising Free2Z URLs
  // as its alternates says nothing true — the previous code built them from
  // the foreign URL, which claimed `?lang=` variants on someone else's domain.
  const alternates =
    canonicalUrl && canonicalUrl === localizedCanonicalUrl
      ? articleLanguageAlternates(
          baseCanonicalUrl,
          availableLanguages,
          (article as any)?.source_language,
        )
      : [];
  const imageUrl = buildImage(article);
  const imageAlt = article?.title
    ? translateMessage(
        META_MESSAGES.featuredImageAlt,
        { title: article.title },
        translator,
      )
    : DEFAULT_SOCIAL_IMAGE_ALT;
  const publishedTime =
    article?.published_at || article?.publish_at || article?.created_at;
  const modifiedTime = article?.updated_at || article?.created_at;

  const ogLocaleValue = ogLocale(article);
  const tags: MetaTag[] = [
    { tag: "meta", props: { name: "description", content: description } },
    { tag: "meta", props: { name: "robots", content: DEFAULT_ROBOTS } },
    { tag: "meta", props: { property: "og:title", content: title } },
    {
      tag: "meta",
      props: { property: "og:description", content: description },
    },
    {
      tag: "meta",
      props: { property: "og:url", content: canonicalUrl || canonicalBaseUrl },
    },
    { tag: "meta", props: { property: "og:image", content: imageUrl } },
    {
      tag: "meta",
      props: { property: "og:image:secure_url", content: imageUrl },
    },
    { tag: "meta", props: { property: "og:image:type", content: "image/png" } },
    {
      tag: "meta",
      props: {
        property: "og:image:width",
        content: DEFAULT_SOCIAL_IMAGE_WIDTH.toString(),
      },
    },
    {
      tag: "meta",
      props: {
        property: "og:image:height",
        content: DEFAULT_SOCIAL_IMAGE_HEIGHT.toString(),
      },
    },
    { tag: "meta", props: { property: "og:image:alt", content: imageAlt } },
    { tag: "meta", props: { property: "og:type", content: "article" } },
    { tag: "meta", props: { property: "og:site_name", content: SITE_NAME } },
    // Spread rather than a fixed entry: `ogLocale` returns undefined when it
    // cannot name a real locale, and omitting the tag beats asserting a
    // false one.
    ...(ogLocaleValue
      ? [
          {
            tag: "meta" as const,
            props: { property: "og:locale", content: ogLocaleValue },
          },
        ]
      : []),
    {
      tag: "meta",
      props: { name: "twitter:card", content: "summary_large_image" },
    },
    { tag: "meta", props: { name: "twitter:title", content: title } },
    {
      tag: "meta",
      props: { name: "twitter:description", content: description },
    },
    {
      tag: "meta",
      props: { name: "twitter:url", content: canonicalUrl || canonicalBaseUrl },
    },
    { tag: "meta", props: { name: "twitter:image", content: imageUrl } },
    { tag: "meta", props: { name: "twitter:image:alt", content: imageAlt } },
    // Attribution parity with the Django card tier ( phase 3): these three
    // were the only tags `zpage/social.html` emitted that SSR did not, so
    // adding them makes SSR a strict superset and lets the prerender branch be
    // deleted without any card losing information.
    { tag: "meta", props: { name: "twitter:site", content: TWITTER_SITE } },
    {
      tag: "meta",
      props: { name: "twitter:creator", content: TWITTER_CREATOR },
    },
    { tag: "meta", props: { property: "fb:app_id", content: FACEBOOK_APP_ID } },
  ];

  if (publishedTime) {
    tags.push({
      tag: "meta",
      props: { property: "article:published_time", content: publishedTime },
    });
  }
  if (modifiedTime) {
    tags.push({
      tag: "meta",
      props: { property: "article:modified_time", content: modifiedTime },
    });
  }
  if (article?.creator?.username) {
    tags.push({
      tag: "meta",
      props: { name: "author", content: article.creator.username },
    });
  }

  const jsonLd = buildJsonLd(article, canonicalUrl, description, imageUrl);
  return {
    title: headTitle,
    canonical: canonicalUrl,
    alternates,
    tags,
    jsonLd,
    jsonLdString: jsonLd ? escapeJsonForHtml(JSON.stringify(jsonLd)) : null,
  };
}
