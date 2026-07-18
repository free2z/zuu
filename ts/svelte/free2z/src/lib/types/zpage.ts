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
}

export interface ZPage {
  id: number;
  free2zaddr: string;
  vanity?: string;
  title: string;
  content: string;
  description?: string;
  category: string;
  is_published: boolean;
  is_subscriber_only: boolean;
  is_verified: boolean;
  total: string;
  f2z_score: string;
  created_at: string;
  updated_at: string;
  publish_at?: string;
  get_url: string;
  p2paddr: string;
  featured_image?: FeaturedImage;
  creator: SimpleCreator;
  tags: string[];
  comments?: any[]; // We can expand this later
}

export interface ZPageListItem extends Omit<ZPage, 'content'> {
  content: string; // Truncated version for list display
}

export interface CreateZPageData {
  title: string;
  content: string;
  description?: string;
  category?: string;
  is_published?: boolean;
  is_subscriber_only?: boolean;
  vanity?: string;
  tags?: string[];
  featured_image?: number; // ID of uploaded image
}

export interface UpdateZPageData extends Partial<CreateZPageData> {
  free2zaddr: string;
}

export const CATEGORY_CHOICES = [
  { value: '', label: 'None' },
  { value: 'ART', label: 'Art' },
  { value: 'COMEDY', label: 'Comedy' },
  { value: 'COMMUNITY', label: 'Community' },
  { value: 'CHARITY', label: 'Charity' },
  { value: 'CRYPTO', label: 'Crypto' },
  { value: 'EDUCATION', label: 'Education' },
  { value: 'FICTION', label: 'Fiction' },
  { value: 'FOR TRADE', label: 'For Trade' },
  { value: 'FREE2Z', label: 'Free2z' },
  { value: 'FUNDRAISING', label: 'Fundraising' },
  { value: 'GAMING', label: 'Gaming' },
  { value: 'HEALTH', label: 'Health' },
  { value: 'LIFESTYLE', label: 'Lifestyle' },
  { value: 'MATH', label: 'Math' },
  { value: 'MUSIC', label: 'Music' },
  { value: 'PODCAST', label: 'Podcast' },
  { value: 'POLITICS', label: 'Politics' },
  { value: 'RELIEF', label: 'Relief' },
  { value: 'SCIENCE', label: 'Science' },
  { value: 'SERVICE', label: 'Service' },
  { value: 'SPORTS', label: 'Sports' },
  { value: 'TECHNOLOGY', label: 'Technology' },
  { value: 'ZCASH', label: 'Zcash' },
];
