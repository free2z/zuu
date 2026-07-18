export interface CoverLibraryImage {
  id: number;
  url: string;
  thumbnail?: string | null;
  title?: string;
  name?: string;
  mime_type: string;
  created_at?: string;
  access?: string;
}

export interface CoverLibraryResponse {
  results?: CoverLibraryImage[];
  next?: string | null;
}
