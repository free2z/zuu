import type { TranslationFunction } from "$lib/i18n";

/**
 * Display labels for `zPage.category`.
 *
 * This is NOT the tag vocabulary. `category` is a genuine closed enum — a
 * `CharField(choices=CATEGORY_CHOICES)` in `py/dj/apps/g12f/models/zpage.py`
 * whose values are constrained by the database, so a finite lookup is the
 * honest shape for it. Tags are the open vocabulary and have no table here on
 * purpose: they are creator-authored in whatever language the creator writes
 * in, and translating them would be inventing meaning we were never told.
 *
 * A table rather than the `switch` this replaced, so adding a category is a
 * data edit next to the migration that adds the choice, not a control-flow
 * edit. Anything absent falls through to the value itself, which is what makes
 * it safe to call on a free-form tag.
 */
export const CATEGORY_LABELS: Readonly<
  Record<string, { key: string; english: string }>
> = {
  ART: { key: "art", english: "Art" },
  COMEDY: { key: "comedy", english: "Comedy" },
  COMMUNITY: { key: "community", english: "Community" },
  CHARITY: { key: "charity", english: "Charity" },
  CRYPTO: { key: "crypto", english: "Crypto" },
  EDUCATION: { key: "education", english: "Education" },
  FICTION: { key: "fiction", english: "Fiction" },
  "FOR TRADE": { key: "forTrade", english: "For Trade" },
  FREE2Z: { key: "free2z", english: "Free2Z" },
  FUNDRAISING: { key: "fundraising", english: "Fundraising" },
  GAMING: { key: "gaming", english: "Gaming" },
  HEALTH: { key: "health", english: "Health" },
  LIFESTYLE: { key: "lifestyle", english: "Lifestyle" },
  MATH: { key: "math", english: "Math" },
  MUSIC: { key: "music", english: "Music" },
  PODCAST: { key: "podcast", english: "Podcast" },
  POLITICS: { key: "politics", english: "Politics" },
  RELIEF: { key: "relief", english: "Relief" },
  SCIENCE: { key: "science", english: "Science" },
  SERVICE: { key: "service", english: "Service" },
  SPORTS: { key: "sports", english: "Sports" },
  TECHNOLOGY: { key: "technology", english: "Technology" },
  ZCASH: { key: "zcash", english: "Zcash" },
};

export function translateCategory(
  category: string,
  translate: TranslationFunction,
): string {
  const entry = CATEGORY_LABELS[category.trim().toUpperCase()];
  if (!entry) return category;
  return translate(`editor.categoryNames.${entry.key}`, entry.english);
}
