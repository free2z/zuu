/**
 * A catalog is valid when its flattened key set equals the declared key set
 * exactly: no missing key (a runtime throw) and no extra key (a message no
 * screen reads, which is how stale translations survive).
 */
export function flattenCatalog(
  catalog: unknown,
  prefix = "",
  into: Set<string> = new Set(),
): Set<string> {
  if (typeof catalog !== "object" || catalog === null || Array.isArray(catalog)) {
    throw new Error(`i18n catalog must be a plain object at ${prefix || "<root>"}`);
  }
  for (const [key, value] of Object.entries(catalog)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") into.add(path);
    else flattenCatalog(value, path, into);
  }
  return into;
}

export function validateCatalog(
  locale: string,
  catalog: unknown,
  declared: ReadonlySet<string>,
): void {
  const present = flattenCatalog(catalog);
  const missing = [...declared].filter((key) => !present.has(key)).sort();
  const extra = [...present].filter((key) => !declared.has(key)).sort();
  if (missing.length > 0) {
    throw new Error(`${locale} catalog is missing: ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    throw new Error(`${locale} catalog declares unknown keys: ${extra.join(", ")}`);
  }
}
