import type { SupportedLocale } from "./locale";
import { IntlMessageFormat } from "intl-messageformat";

type Catalog = Readonly<Record<string, unknown>>;

const KEY_SEGMENT = /^[a-z][A-Za-z0-9]*$/;

function flattenCatalog(
  value: unknown,
  path: readonly string[] = [],
  leaves = new Map<string, string>(),
): Map<string, string> {
  if (typeof value === "string") {
    if (path.length < 2) {
      throw new Error(`message key must include a namespace: ${path.join(".")}`);
    }
    if (value.length === 0) {
      throw new Error(`message must not be empty: ${path.join(".")}`);
    }
    leaves.set(path.join("."), value);
    return leaves;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`message catalog value must be an object or string: ${path.join(".")}`);
  }

  for (const [segment, child] of Object.entries(value)) {
    if (!KEY_SEGMENT.test(segment)) {
      throw new Error(`invalid message-key segment: ${[...path, segment].join(".")}`);
    }
    flattenCatalog(child, [...path, segment], leaves);
  }
  return leaves;
}

export function validateCatalog(
  locale: SupportedLocale,
  catalog: Catalog,
  declaredKeys: readonly string[],
): void {
  const declared = new Set(declaredKeys);
  if (declared.size !== declaredKeys.length) {
    throw new Error("declared message keys must be unique");
  }
  for (const key of declared) {
    const segments = key.split(".");
    if (segments.length < 2 || segments.some((segment) => !KEY_SEGMENT.test(segment))) {
      throw new Error(`invalid declared message key: ${key}`);
    }
  }

  const messages = flattenCatalog(catalog);
  const catalogKeys = new Set(messages.keys());
  const missing = [...declared].filter((key) => !catalogKeys.has(key)).sort();
  const orphaned = [...catalogKeys].filter((key) => !declared.has(key)).sort();
  if (missing.length || orphaned.length) {
    throw new Error(
      `${locale} catalog key mismatch; missing=[${missing.join(", ")}]; orphaned=[${orphaned.join(", ")}]`,
    );
  }
  for (const [key, message] of messages) {
    try {
      new IntlMessageFormat(message, locale);
    } catch {
      throw new Error(`${locale} catalog contains invalid ICU message: ${key}`);
    }
  }
}
