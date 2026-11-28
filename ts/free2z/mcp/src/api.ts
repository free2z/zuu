import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { getOperation, validate, type Schema } from "./catalog.js";
import { redact, type Config } from "./config.js";
export type FileInput = {
  path: string;
  filename?: string;
  content_type?: string;
};
export type CallInput = {
  operation_id: string;
  path?: Record<string, unknown>;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
  content_type?: string;
  files?: Record<string, FileInput | FileInput[]>;
};
const additionalHeaders = new Set([
  "if-match",
  "if-none-match",
  "accept-language",
  "idempotency-key",
  "x-free2z-source-language",
]);
const forbiddenHeaders = new Set([
  "authorization",
  "cookie",
  "host",
  "origin",
  "referer",
  "content-type",
  "content-length",
  "connection",
  "transfer-encoding",
  "x-csrftoken",
]);
const responseHeaders = [
  "etag",
  "last-modified",
  "retry-after",
  "content-type",
  "idempotency-key-honored",
  "idempotent-replayed",
  "x-request-id",
  "x-superseded-idempotency-key",
];
function primitive(value: unknown): string {
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return String(value);
  throw new Error(
    "URL and form values must be strings, finite numbers, booleans, or arrays of those. JSON-encode structured form fields explicitly.",
  );
}
function segment(value: unknown): string {
  const s = primitive(value);
  if (!s || s === "." || s === ".." || /[\/\\?#%\x00-\x1f\x7f]/.test(s))
    throw new Error("Path parameter contains a reserved path character.");
  return encodeURIComponent(s);
}
function validateParameters(
  parameters: Schema[],
  values: Record<string, unknown>,
  location: string,
): void {
  const definitions = parameters.filter((p) => p.in === location);
  for (const parameter of definitions) {
    if (parameter.required && values[parameter.name] === undefined)
      throw new Error(`Missing ${location} parameter: ${parameter.name}`);
    if (values[parameter.name] !== undefined)
      validate(
        parameter.schema ?? {},
        values[parameter.name],
        `${location}.${parameter.name}`,
      );
  }
  for (const key of Object.keys(values))
    if (location !== "query" && !definitions.some((p) => p.name === key))
      throw new Error(
        `Unknown ${location} parameter: ${key}; describe the operation first.`,
      );
}
async function boundedResponse(
  response: Response,
  limit: number,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit)
        throw new Error(
          "Response exceeded FREE2Z_MAX_RESPONSE_BYTES. The request may already have completed; inspect state before retrying a mutation.",
        );
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
export async function execute(
  config: Config,
  input: CallInput,
  readOnly = false,
) {
  const op = getOperation(input.operation_id);
  if (op.unsupported) throw new Error(op.unsupported);
  if (readOnly && op.method !== "GET")
    throw new Error(
      "free2z_read only accepts GET operations; use free2z_execute for mutations.",
    );
  if (op.sessionOnly && !config.session)
    throw new Error(
      "This upload endpoint requires FREE2Z_SESSION_FILE or a session_file account profile; a Knox token cannot authenticate the legacy Django upload handler.",
    );
  const params = op.spec.parameters ?? [];
  if (
    params.some(
      (p: Schema) =>
        p.in === "header" &&
        p.required &&
        p.name.toLowerCase() === "authorization",
    )
  ) {
    throw new Error(
      "This operation requires separate confidential-client authorization and is unavailable with MCP account credentials. Use the service's dedicated authenticated client.",
    );
  }

  validateParameters(params, input.path ?? {}, "path");
  validateParameters(params, input.query ?? {}, "query");
  const path = op.path.replace(/\{([^}]+)\}/g, (_, key) =>
    segment(input.path?.[key]),
  );
  const url = new URL(path, config.baseUrl);
  if (
    url.origin !== config.baseUrl ||
    !path.startsWith("/") ||
    path.startsWith("//")
  )
    throw new Error("Operation escaped the configured origin.");
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value === undefined) continue;
    const parameter = params.find(
      (p: Schema) => p.in === "query" && p.name === key,
    );
    if (Array.isArray(value)) {
      if (parameter?.explode === false)
        url.searchParams.set(key, value.map(primitive).join(","));
      else
        for (const item of value) url.searchParams.append(key, primitive(item));
    } else url.searchParams.set(key, primitive(value));
  }
  const headers = new Headers({ Accept: "application/json" });
  const headerValues = new Map(
    Object.entries(input.headers ?? {}).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
  if (headerValues.size !== Object.keys(input.headers ?? {}).length)
    throw new Error("Duplicate case-insensitive header names.");
  for (const [key, value] of headerValues) {
    const parameter = params.find(
      (p: Schema) => p.in === "header" && p.name.toLowerCase() === key,
    );
    if (
      forbiddenHeaders.has(key) ||
      (!parameter && !additionalHeaders.has(key))
    )
      throw new Error("Header is not an allowed API parameter.");
    if (/[\r\n]/.test(value))
      throw new Error("Header values cannot contain line breaks.");
    if (parameter) validate(parameter.schema ?? {}, value, `headers.${key}`);
    headers.set(key, value);
  }
  for (const p of params.filter((p: Schema) => p.in === "header" && p.required))
    if (!headerValues.has(p.name.toLowerCase()))
      throw new Error(`Missing header: ${p.name}`);
  if (config.token) headers.set("Authorization", `Token ${config.token}`);
  if (config.session) {
    headers.set(
      "Cookie",
      `sessionid=${config.session.sessionid}; csrftoken=${config.session.csrftoken}`,
    );
    headers.set("X-CSRFToken", config.session.csrftoken);
    headers.set("Origin", config.baseUrl);
    headers.set("Referer", `${config.baseUrl}/`);
  }
  const content = op.spec.requestBody?.content ?? {};
  const hasFiles = Object.keys(input.files ?? {}).length > 0;
  const media =
    input.content_type ??
    (hasFiles
      ? "multipart/form-data"
      : Object.hasOwn(content, "application/json")
        ? "application/json"
        : Object.keys(content)[0]);
  const hasBody = input.body !== undefined || hasFiles;
  if (op.spec.requestBody?.required && !hasBody)
    throw new Error("This operation requires a request body.");
  if (!hasBody && input.content_type)
    throw new Error("content_type requires a body.");
  let body: BodyInit | undefined;
  if (hasBody) {
    if (!media || !Object.hasOwn(content, media))
      throw new Error(
        "This operation does not accept that request content type; describe it first.",
      );
    if (hasFiles && media !== "multipart/form-data")
      throw new Error("Files require multipart/form-data.");
    const data = input.body ?? {};
    if (
      media !== "application/json" &&
      (!data || typeof data !== "object" || Array.isArray(data))
    )
      throw new Error("Form body must be an object.");
    const validationData = hasFiles
      ? {
          ...(data as Record<string, unknown>),
          ...Object.fromEntries(
            Object.entries(input.files ?? {}).map(([key, value]) => [
              key,
              Array.isArray(value)
                ? value.map((f) => f.filename ?? basename(f.path))
                : (value.filename ?? basename(value.path)),
            ]),
          ),
        }
      : data;
    // Custom upload schemas describe metadata; binary fields are validated below.
    if (content[media].schema)
      validate(
        content[media].schema,
        op.sessionOnly ? data : validationData,
        "body",
      );
    if (media === "application/json") {
      headers.set("Content-Type", media);
      body = JSON.stringify(data);
    } else {
      const form =
        media === "multipart/form-data"
          ? new FormData()
          : new URLSearchParams();
      for (const [key, value] of Object.entries(
        data as Record<string, unknown>,
      )) {
        if (value === undefined || value === null) continue;
        if (Object.hasOwn(input.files ?? {}, key))
          throw new Error("A field cannot appear in both body and files.");
        for (const item of Array.isArray(value) ? value : [value])
          form.append(key, primitive(item));
      }
      let total = 0;
      for (const [field, entries] of Object.entries(input.files ?? {})) {
        if (
          (op.id === "uploads_single_public" && field !== "file") ||
          (op.id === "uploads_batch" && field !== "files")
        )
          throw new Error("Unexpected upload file field.");
        const files = Array.isArray(entries) ? entries : [entries];
        if (op.id === "uploads_single_public" && files.length !== 1)
          throw new Error("Single upload requires exactly one file.");
        for (const file of files) {
          const info = await stat(file.path);
          if (!info.isFile())
            throw new Error("Upload path must name a regular file.");
          total += info.size;
          if (total > config.maxUploadBytes)
            throw new Error("Upload exceeds FREE2Z_MAX_UPLOAD_BYTES.");
          const filename = file.filename ?? basename(file.path);
          if (!filename || /[\x00-\x1f\x7f\/\\]/.test(filename))
            throw new Error("Upload filename must be a plain filename.");
          (form as FormData).append(
            field,
            await openAsBlob(file.path, {
              type: file.content_type ?? "application/octet-stream",
            }),
            filename,
          );
        }
      }
      if (op.sessionOnly && !hasFiles)
        throw new Error("Upload requires files.");
      if (op.id === "uploads_batch") {
        let metadata: unknown;
        try {
          metadata = JSON.parse(String((data as Schema).body));
        } catch {
          throw new Error(
            "Batch body.body must be a JSON array of file metadata.",
          );
        }
        const files = input.files?.files;
        if (
          !Array.isArray(metadata) ||
          metadata.length !==
            (Array.isArray(files) ? files.length : files ? 1 : 0) ||
          metadata.length === 0
        )
          throw new Error(
            "Batch metadata must contain exactly one object per file.",
          );
      }
      if (media === "application/x-www-form-urlencoded")
        headers.set("Content-Type", media);
      body = form;
    }
  }
  let response: Response;
  let raw: string;
  try {
    response = await fetch(url, {
      method: op.method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    raw = await boundedResponse(response, config.maxResponseBytes);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Response exceeded"))
      throw error;
    throw new Error(
      "Free2Z request failed or timed out. Mutations may have completed; inspect state or use the original idempotency key before retrying. No automatic retry was performed.",
    );
  }
  if (
    response.status >= 300 &&
    response.status < 400 &&
    response.status !== 304
  )
    throw new Error(
      `Free2Z returned HTTP ${response.status} redirect. Redirects are never followed; check the origin and sign-in status in your browser.`,
    );
  let data: unknown = null;
  if (raw) {
    if (/\bjson\b/i.test(response.headers.get("content-type") ?? "")) {
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(
          `Free2Z returned invalid JSON (HTTP ${response.status}).`,
        );
      }
    } else {
      // HTML sign-in/error pages can contain credentials, CSRF tokens or stack
      // traces. Only JSON and explicit event streams are exposed to the model.
      data = response.headers
        .get("content-type")
        ?.startsWith("text/event-stream")
        ? raw
        : {
            message: "Non-JSON response omitted.",
            bytes: Buffer.byteLength(raw),
          };
    }
  }
  return redact(
    {
      operation_id: op.id,
      status: response.status,
      ok: response.ok || response.status === 304,
      headers: Object.fromEntries(
        responseHeaders
          .filter((key) => response.headers.has(key))
          .map((key) => [key, response.headers.get(key)]),
      ),
      data,
    },
    config,
  ) as {
    operation_id: string;
    status: number;
    ok: boolean;
    headers: Record<string, string>;
    data: unknown;
  };
}
