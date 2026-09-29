import { failure } from "./error.js";
import type { Json, ObjectData } from "./types.js";

/** Parse integer lexemes directly to bigint, before Number can round them. */
export function parseJson(text: string): Json {
  let at = 0,
    nodes = 0;
  const space = () => {
    while (/[\x20\t\r\n]/.test(text[at] ?? "\0")) at++;
  };
  function value(depth: number): Json {
    if (depth > 64 || ++nodes > 65_536) failure("response_too_complex");
    space();
    const start = at;
    const char = text[at++];
    if (char === '"') {
      let escaped = false;
      while (at < text.length) {
        const c = text[at++];
        if (!escaped && c === '"') {
          try {
            return JSON.parse(text.slice(start, at)) as string;
          } catch {
            failure("invalid_response");
          }
        }
        if (!escaped && c === "\\") escaped = true;
        else escaped = false;
      }
      failure("invalid_response");
    }
    if (char === "[" || char === "{") {
      const list: Json[] = [];
      const object: ObjectData = Object.create(null) as ObjectData;
      space();
      const end = char === "[" ? "]" : "}";
      if (text[at] === end) {
        at++;
        return char === "[" ? list : object;
      }
      for (;;) {
        if (char === "[") list.push(value(depth + 1));
        else {
          space();
          if (text[at] !== '"') failure("invalid_response");
          const key = value(depth + 1);
          if (typeof key !== "string" || Object.hasOwn(object, key))
            failure("invalid_response");
          space();
          if (text[at++] !== ":") failure("invalid_response");
          object[key] = value(depth + 1);
        }
        space();
        const next = text[at++];
        if (next === end) return char === "[" ? list : object;
        if (next !== ",") failure("invalid_response");
      }
    }
    at = start;
    for (const [literal, result] of [
      ["null", null],
      ["true", true],
      ["false", false],
    ] as const) {
      if (text.startsWith(literal, at)) {
        at += literal.length;
        return result;
      }
    }
    const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      text.slice(at),
    )?.[0];
    if (!token || token.length > 128) failure("invalid_response");
    at += token.length;
    if (!/[.eE]/.test(token)) return BigInt(token);
    const number = Number(token);
    if (!Number.isFinite(number)) failure("invalid_response");
    if (Number.isInteger(number) && !Number.isSafeInteger(number))
      failure("unsafe_integer");
    return number;
  }
  const result = value(0);
  space();
  if (at !== text.length) failure("invalid_response");
  return result;
}

/** Emits bigint as JSON integer lexemes; rejects already-rounded JS integers. */
export function stringifyJson(input: unknown): string {
  const seen = new Set<object>();
  function encode(value: unknown, depth: number): string {
    if (depth > 64) failure("invalid_request");
    if (value === null) return "null";
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "number") {
      if (
        !Number.isFinite(value) ||
        (Number.isInteger(value) && !Number.isSafeInteger(value))
      )
        failure("unsafe_integer");
      return JSON.stringify(value);
    }
    if (typeof value === "string" || typeof value === "boolean")
      return JSON.stringify(value);
    if (typeof value !== "object" || seen.has(value))
      failure("invalid_request");
    seen.add(value);
    const result = Array.isArray(value)
      ? `[${value.map((item) => encode(item, depth + 1)).join(",")}]`
      : `{${Object.entries(value)
          .filter(([, item]) => item !== undefined)
          .map(
            ([key, item]) =>
              `${JSON.stringify(key)}:${encode(item, depth + 1)}`,
          )
          .join(",")}}`;
    seen.delete(value);
    return result;
  }
  return encode(input, 0);
}
export function object(value: unknown): ObjectData {
  if (!value || typeof value !== "object" || Array.isArray(value))
    failure("invalid_response");
  return value as ObjectData;
}
export function string(value: unknown): string {
  if (typeof value !== "string") failure("invalid_response");
  return value;
}
export function uint(value: unknown): bigint {
  if (
    typeof value !== "bigint" ||
    value < 0n ||
    value > 18_446_744_073_709_551_615n
  )
    failure("invalid_response");
  return value;
}

/**
 * The request as sent: `max_output_tokens_strict` is checked to be a boolean
 * and dropped unless `true`, so a request that does not opt in is
 * byte-identical to one made before the field existed (and an older gateway,
 * which refuses unknown fields, still accepts it).
 */
export function strictOutput<
  T extends { max_output_tokens_strict?: boolean; max_output_tokens?: unknown },
>(request: T): T {
  const { max_output_tokens_strict: strict, ...rest } = request;
  if (strict === undefined || strict === false) return rest as T;
  if (strict !== true || rest.max_output_tokens === undefined)
    failure("invalid_request");
  return { ...rest, max_output_tokens_strict: true } as T;
}
