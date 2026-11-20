import { readFileSync } from "node:fs";
import { Ajv, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

// OpenAPI 3.0 is JSON Schema draft-07 plus nullable and annotation keywords.
export type Schema = Record<string, any>;
export type Operation = {
  id: string;
  method: string;
  path: string;
  spec: Schema;
  sessionOnly?: boolean;
};
export const document: Schema = JSON.parse(
  readFileSync(new URL("../schema.json", import.meta.url), "utf8"),
);
const methods = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
]);
// Full account archives require native in-session authentication and are not
// delegated through this local MCP server. The canonical schema still includes
// them for ordinary API clients; discovery is not authorization to expose them.
const privateAccountExportOperations = new Set([
  "account_data_export_create",
  "account_data_export_latest",
  "account_data_export_retrieve",
  "account_data_export_download",
]);
export const operations = new Map<string, Operation>();
for (const [path, item] of Object.entries(document.paths) as [
  string,
  Schema,
][]) {
  for (const [method, spec] of Object.entries(item) as [string, Schema][]) {
    if (!methods.has(method) || !spec.operationId) continue;
    if (privateAccountExportOperations.has(spec.operationId)) continue;
    if (operations.has(spec.operationId))
      throw new Error("Duplicate API operation ID");
    operations.set(spec.operationId, {
      id: spec.operationId,
      method: method.toUpperCase(),
      path,
      spec: {
        ...spec,
        parameters: [...(item.parameters ?? []), ...(spec.parameters ?? [])],
      },
    });
  }
}
// The hand-written page queryset accepts these public filters; the generated
// schema currently omits them. Keep discovery useful while allowing additional
// primitive query parameters for server-side filters not described by OpenAPI.
operations.get("zpage_list")!.spec.parameters.push(
  {
    in: "query",
    name: "search",
    schema: { type: "string" },
    description: "Search page text.",
  },
  {
    in: "query",
    name: "username",
    schema: { type: "string" },
    description: "Filter by creator username.",
  },
  ...["unverified", "created_at__gte", "created_at__lte", "homeSort"].map(
    (name) => ({ in: "query", name, schema: { type: "string" } }),
  ),
);
const uploadMetadata = {
  type: "object",
  properties: {
    title: { type: "string" },
    description: { type: "string" },
    access: { type: "string", enum: ["public", "private", "members"] },
  },
};
for (const op of [
  {
    id: "uploads_single_public",
    path: "/uploads/single-public",
    description:
      "Upload one actual file. Requires session authentication. File field: file. Metadata body: title, description, access. Read uploads_limit before uploading. Server enforces file types and storage balance.",
    schema: uploadMetadata,
  },
  {
    id: "uploads_batch",
    path: "/uploads/handle",
    description:
      "Upload files atomically. Requires session authentication. Files field: files (array). Body field body is a JSON-encoded array of metadata objects (title, description, access), one per file in the same order. Read uploads_limit first.",
    schema: {
      type: "object",
      properties: { body: { type: "string" } },
      required: ["body"],
      additionalProperties: false,
    },
  },
])
  operations.set(op.id, {
    id: op.id,
    method: "POST",
    path: op.path,
    sessionOnly: true,
    spec: {
      description: op.description,
      tags: ["uploads"],
      parameters: [],
      requestBody: {
        required: true,
        content: { "multipart/form-data": { schema: op.schema } },
      },
    },
  });

export function getOperation(id: string): Operation {
  const op = operations.get(id);
  if (!op)
    throw new Error("Unknown operation_id; use free2z_search_operations.");
  return op;
}
export function summary(op: Operation) {
  return {
    operation_id: op.id,
    method: op.method,
    path: op.path,
    tags: op.spec.tags ?? [],
    description: (op.spec.summary ?? op.spec.description ?? "").split("\n")[0],
    session_only: op.sessionOnly ?? false,
  };
}
export function describe(op: Operation) {
  const components: Schema = {};
  const visit = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (
      typeof node.$ref === "string" &&
      node.$ref.startsWith("#/components/schemas/")
    ) {
      const name = node.$ref.slice("#/components/schemas/".length);
      if (!(name in components)) {
        components[name] = document.components.schemas[name];
        visit(components[name]);
      }
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(op.spec);
  return {
    ...summary(op),
    operation: op.spec,
    components: { schemas: components },
    notes: [
      "Use path/query/headers/body objects. Preserve decimal money values as strings. Responses include pagination; request each page explicitly. Additional primitive/array query parameters are forwarded for server filters omitted by OpenAPI.",
      "Headers accept declared API headers plus If-Match, If-None-Match, Accept-Language, Idempotency-Key, X-Free2Z-Source-Language. Reuse the SAME idempotency key and body only when retrying the same action. No automatic retries.",
      "files maps multipart fields to {path, filename?, content_type?}, or arrays thereof. Paths identify local regular files. Only upload files the user authorized.",
      "MCP retains API permission, recent-login, MFA, CAPTCHA and balance requirements. Browser-only authentication flows and redirects require the browser. Credentials in responses are redacted.",
    ],
  };
}

// Request validation must not require response-only fields from shared serializers.
function inputSchema(node: any): any {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(inputSchema);
  const copy: Schema = Object.fromEntries(
    Object.entries(node).map(([key, value]) => [key, inputSchema(value)]),
  );
  if (node.properties) {
    copy.properties = Object.fromEntries(
      Object.entries(node.properties)
        .filter(([, value]) => !(value as Schema).readOnly)
        .map(([key, value]) => [key, inputSchema(value)]),
    );
    if (node.required)
      copy.required = node.required.filter(
        (key: string) => key in copy.properties,
      );
  }
  // drf-spectacular uses nullable beside a $ref/allOf; AJV's native nullable
  // needs a type, so express it in ordinary JSON Schema instead.
  if (copy.nullable) {
    delete copy.nullable;
    return { anyOf: [copy, { type: "null" }] };
  }
  return copy;
}
const ajv = new Ajv({
  strict: false,
  allErrors: true,
  formats: { decimal: /^-?[0-9]+(?:\.[0-9]+)?$/ },
});
(addFormats as unknown as (ajv: Ajv) => void)(ajv);
const validators = new Map<Schema, ValidateFunction>();
export function validate(schema: Schema, value: unknown, label: string): void {
  let validator = validators.get(schema);
  if (!validator) {
    validator = ajv.compile({
      ...inputSchema(schema),
      components: inputSchema(document.components),
    });
    validators.set(schema, validator);
  }
  if (!validator(value))
    throw new Error(
      `${label}: ${ajv.errorsText(validator.errors, { dataVar: label })}`,
    );
}
