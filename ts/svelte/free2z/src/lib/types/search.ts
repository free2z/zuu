import type { ZPageList } from "$lib/api/f2z.schemas";

export interface PublicSeries {
  id: string;
  name: string;
  pageorder_set: Array<{
    page: ZPageList;
    order: number;
  }>;
  creator: number;
  created_at: string;
  updated_at: string;
}
