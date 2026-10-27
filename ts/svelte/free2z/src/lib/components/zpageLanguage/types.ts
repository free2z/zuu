/** One row of the editor's Translations panel — see `buildVariantRows`. */
export interface VariantRow {
  language: string;
  /** The tag to navigate/write with — differs from `language` only for a
   *  legacy `und` source, which has no display name but is still openable. */
  navigateAs: string;
  status: "source" | "published" | "draft" | "written" | "not-started";
  isStale: boolean;
  origin: "source" | "human" | "ai" | null;
  isSource: boolean;
  exists: boolean;
  canDelete: boolean;
}

// `ZPageVariantSummary` is NOT redeclared here:  put it in the schema, so
// the generated `$lib/api/f2z.schemas` type is the only definition. A local
// copy would keep compiling after the contract changed underneath it.
