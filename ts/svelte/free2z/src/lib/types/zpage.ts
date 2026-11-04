export interface FeaturedImage {
  id: number;
  url: string;
  thumbnail: string;
  mime_type: string;
  file_size: number;
}

export interface SimpleCreator {
  id: number;
  username: string;
  full_name?: string;
  avatar_image?: FeaturedImage;
  is_verified: boolean;
  /** The creator's profile Zcash address (what an inheriting page pays). */
  p2paddr?: string;
}

export interface ZPage {
  id: number;
  free2zaddr: string;
  vanity?: string;
  title: string;
  content: string;
  description?: string;
  canonical_url?: string;
  // Content languages are BCP-47 tags from `py/f2z/languages.py`, not the four
  // product-UI locales ( §3.3). a variant can be `ja`; the old
  // four-value union is what made such a variant invisible in the editor.
  // `und` is still emitted by legacy rows and is never rendered — see
  // `languageDisplayName`.
  /**
   * NULL means detection has not run yet ( §3.2) — the honest, transient
   * replacement for the `und` sentinel. Nothing writes NULL until the
   * detection wave, but the column and the schema are already nullable, and
   * code that assumes otherwise breaks the day it lands.
   */
  source_language: string | null;
  requested_language: string;
  actual_language: string;
  fallback_used: boolean;
  available_languages: string[];
  /** Detection output ( Part 5). Absent until P5/P6 are deployed. */
  detected_language?: string | null;
  detection_confidence?: number | null;
  language_source?: "detected" | "creator" | null;
  variant_is_published: boolean;
  category: string;
  is_published: boolean;
  is_subscriber_only: boolean;
  is_verified: boolean;
  total: string;
  f2z_score: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  publish_at?: string | null;
  get_url: string;
  /** EFFECTIVE support address: the page's own, else the creator's. */
  p2paddr: string;
  /**
   * The page's OWN address, `null` when it inherits the creator's.
   * Absent from a backend that predates the field.
   */
  p2paddr_override?: string | null;
  featured_image?: FeaturedImage;
  creator: SimpleCreator;
  tags: string[];
  comments?: any[]; // We can expand this later
}

export interface ZPageListItem extends Omit<ZPage, "content"> {
  content: string; // Truncated version for list display
}

export interface CreateZPageData {
  title: string;
  content: string;
  description?: string;
  canonical_url?: string;
  category?: string;
  is_published?: boolean;
  is_subscriber_only?: boolean;
  vanity?: string;
  tags?: string[];
  featured_image?: number; // ID of uploaded image
  publish_at?: string | null;
  source_language?: "en" | "es" | "fr" | "pt-BR";
}

export interface UpdateZPageData extends Partial<CreateZPageData> {
  free2zaddr: string;
}

export const CATEGORY_CHOICES = [
  { value: "", label: "None" },
  { value: "ART", label: "Art" },
  { value: "COMEDY", label: "Comedy" },
  { value: "COMMUNITY", label: "Community" },
  { value: "CHARITY", label: "Charity" },
  { value: "CRYPTO", label: "Crypto" },
  { value: "EDUCATION", label: "Education" },
  { value: "FICTION", label: "Fiction" },
  { value: "FOR TRADE", label: "For Trade" },
  { value: "FREE2Z", label: "Free2z" },
  { value: "FUNDRAISING", label: "Fundraising" },
  { value: "GAMING", label: "Gaming" },
  { value: "HEALTH", label: "Health" },
  { value: "LIFESTYLE", label: "Lifestyle" },
  { value: "MATH", label: "Math" },
  { value: "MUSIC", label: "Music" },
  { value: "PODCAST", label: "Podcast" },
  { value: "POLITICS", label: "Politics" },
  { value: "RELIEF", label: "Relief" },
  { value: "SCIENCE", label: "Science" },
  { value: "SERVICE", label: "Service" },
  { value: "SPORTS", label: "Sports" },
  { value: "TECHNOLOGY", label: "Technology" },
  { value: "ZCASH", label: "Zcash" },
];
