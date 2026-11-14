/** Relative HTML inputs shared by Vite and the document-destination audit.
 * These are full-document entries, never additions to the SPA route table.
 */
export function htmlBuildInputs(localDraftEvaluation: boolean): Record<string, string> {
  return {
    main: "index.html",
    ...(localDraftEvaluation ? { localDraft: "local-draft.html" } : {}),
  };
}
