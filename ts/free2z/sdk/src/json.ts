import { failure } from "./error.js";
import type {
  Json,
  ObjectData,
  ReasoningEffort,
  ResponseFormat,
  Tool,
  ToolChoice,
} from "./types.js";

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

/** The gateway's bound on `response_format.json_schema.schema`, serialized. */
export const MAX_RESPONSE_SCHEMA_BYTES = 32 * 1024;
/**
 * The request as sent: `response_format` is checked against the gateway's
 * limits and rebuilt from the members it names, so a request the gateway
 * would refuse is refused here, before any network or bridge call, and an
 * absent format is not on the wire at all (an older gateway refuses the
 * field). The gateway re-checks; this is not the authority.
 */
export function responseFormat<T extends { response_format?: ResponseFormat }>(
  request: T,
): T {
  const { response_format: format, ...rest } = request;
  if (format === undefined) return rest as T;
  if (!format || typeof format !== "object" || Array.isArray(format))
    failure("invalid_request");
  const members = Object.keys(format);
  if (format.type === "json_object") {
    if (members.length !== 1) failure("invalid_request");
    return { ...rest, response_format: { type: "json_object" } } as T;
  }
  if (format.type !== "json_schema" || members.length !== 2)
    failure("invalid_request");
  const spec: unknown = format.json_schema;
  if (!spec || typeof spec !== "object" || Array.isArray(spec))
    failure("invalid_request");
  const { name, schema, strict, ...extra } = spec as Record<string, unknown>;
  if (
    Object.keys(extra).length > 0 ||
    typeof name !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(name) ||
    !schema ||
    typeof schema !== "object" ||
    Array.isArray(schema) ||
    (strict !== undefined && typeof strict !== "boolean") ||
    new TextEncoder().encode(stringifyJson(schema)).length >
      MAX_RESPONSE_SCHEMA_BYTES
  )
    failure("invalid_request");
  const json_schema: { name: string; schema: Json; strict?: boolean } = {
    name,
    schema: schema as Json,
  };
  if (strict !== undefined) json_schema.strict = strict;
  return {
    ...rest,
    response_format: { type: "json_schema", json_schema },
  } as T;
}

const REASONING_EFFORTS: readonly string[] = [
  "minimal",
  "low",
  "medium",
  "high",
];
/**
 * The request as sent: `reasoning_effort` must be one of the four wire
 * values (anything else — `"none"`, `"xhigh"`, `null` — is refused here,
 * before any network or bridge call) and is dropped when absent, so a request
 * that does not set it is byte-identical to one made before the field
 * existed. The gateway re-checks, and alone decides whether the model takes it.
 */
export function reasoningEffort<
  T extends { reasoning_effort?: ReasoningEffort },
>(request: T): T {
  const { reasoning_effort: effort, ...rest } = request;
  if (effort === undefined) return rest as T;
  if (typeof effort !== "string" || !REASONING_EFFORTS.includes(effort))
    failure("invalid_request");
  return { ...rest, reasoning_effort: effort } as T;
}

/** The gateway's limits on `tools` (`ChatRequest::check_tools`). */
export const MAX_TOOLS = 128;
export const MAX_TOOL_SCHEMA_BYTES = 32 * 1024;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * The request as sent: `tools`, `tool_choice` and `parallel_tool_calls` are
 * checked against the gateway's structural limits and rebuilt from the
 * members they name, so a request the gateway would refuse is refused here,
 * before any network or bridge call, and an absent member is not on the
 * wire. Whether the MODEL supports them is the gateway's (catalogue) call.
 */
export function toolOptions<
  T extends {
    tools?: Tool[];
    tool_choice?: ToolChoice;
    parallel_tool_calls?: boolean;
  },
>(request: T): T {
  const {
    tools,
    tool_choice: choice,
    parallel_tool_calls: parallel,
    ...rest
  } = request;
  const result = rest as T;
  const names = new Set<string>();
  if (tools !== undefined) {
    if (!Array.isArray(tools) || tools.length > MAX_TOOLS)
      failure("invalid_request");
    result.tools = tools.map((tool: unknown) => {
      if (!tool || typeof tool !== "object" || Array.isArray(tool))
        failure("invalid_request");
      const { name, description, parameters, strict, ...extra } =
        tool as Record<string, unknown>;
      if (
        Object.keys(extra).length > 0 ||
        typeof name !== "string" ||
        !TOOL_NAME.test(name) ||
        names.has(name) ||
        (description !== undefined && typeof description !== "string") ||
        !parameters ||
        typeof parameters !== "object" ||
        Array.isArray(parameters) ||
        (strict !== undefined && typeof strict !== "boolean") ||
        new TextEncoder().encode(stringifyJson(parameters)).length >
          MAX_TOOL_SCHEMA_BYTES
      )
        failure("invalid_request");
      names.add(name);
      const out: Tool = { name, parameters: parameters as Json };
      if (description !== undefined) out.description = description;
      if (strict !== undefined) out.strict = strict;
      return out;
    });
  }
  const anyTools = names.size > 0;
  if (choice !== undefined) {
    if (!anyTools) failure("invalid_request");
    if (choice === "auto" || choice === "none" || choice === "required")
      result.tool_choice = choice;
    else {
      const named = choice as unknown;
      if (!named || typeof named !== "object" || Array.isArray(named))
        failure("invalid_request");
      const { type, function: fn, ...extra } = named as Record<string, unknown>;
      if (
        type !== "function" ||
        Object.keys(extra).length > 0 ||
        !fn ||
        typeof fn !== "object" ||
        Array.isArray(fn)
      )
        failure("invalid_request");
      const { name, ...fnExtra } = fn as Record<string, unknown>;
      if (
        Object.keys(fnExtra).length > 0 ||
        typeof name !== "string" ||
        !names.has(name)
      )
        failure("invalid_request");
      result.tool_choice = { type: "function", function: { name } };
    }
  }
  if (parallel !== undefined) {
    if (typeof parallel !== "boolean" || !anyTools) failure("invalid_request");
    result.parallel_tool_calls = parallel;
  }
  return result;
}
