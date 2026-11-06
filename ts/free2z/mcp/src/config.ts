import { readFileSync, statSync } from "node:fs";
export type Config = {
  baseUrl: string;
  token?: string;
  session?: { sessionid: string; csrftoken: string };
  timeoutMs: number;
  maxResponseBytes: number;
  maxUploadBytes: number;
};
function secretFile(path: string): string {
  const st = statSync(path);
  if (!st.isFile() || st.size > 65536)
    throw new Error(
      "Credential file must be a regular file smaller than 64 KiB.",
    );
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0)
    throw new Error("Credential file must be private: chmod 600 the file.");
  return readFileSync(path, "utf8").trim();
}
function positive(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new Error("Limits must be positive safe integers.");
  return n;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const url = new URL(env.FREE2Z_BASE_URL ?? "https://free2z.cash");
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
      ))
  )
    throw new Error(
      "FREE2Z_BASE_URL must be an HTTPS origin (or HTTP loopback for local development), with no path or credentials.",
    );
  const modes = [
    env.FREE2Z_TOKEN,
    env.FREE2Z_TOKEN_FILE,
    env.FREE2Z_SESSION_FILE,
  ].filter((value) => value !== undefined);
  if (modes.length > 1)
    throw new Error(
      "Configure exactly one of FREE2Z_TOKEN, FREE2Z_TOKEN_FILE or FREE2Z_SESSION_FILE.",
    );
  const token =
    env.FREE2Z_TOKEN_FILE !== undefined
      ? secretFile(env.FREE2Z_TOKEN_FILE)
      : env.FREE2Z_TOKEN?.trim();
  if (token !== undefined && !/^[A-Za-z0-9._~-]+$/.test(token))
    throw new Error(
      "Token must be a nonempty raw token without an authorization prefix.",
    );
  let session: Config["session"];
  if (env.FREE2Z_SESSION_FILE !== undefined) {
    let parsed: any;
    try {
      parsed = JSON.parse(secretFile(env.FREE2Z_SESSION_FILE));
    } catch {
      throw new Error(
        "Cannot read private session JSON file. Expected sessionid and csrftoken.",
      );
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !["sessionid", "csrftoken"].every(
        (key) =>
          typeof parsed[key] === "string" && /^[A-Za-z0-9]+$/.test(parsed[key]),
      )
    )
      throw new Error(
        "Session JSON must contain nonempty sessionid and csrftoken cookie values.",
      );
    session = { sessionid: parsed.sessionid, csrftoken: parsed.csrftoken };
  }
  return {
    baseUrl: url.origin,
    token,
    session,
    timeoutMs: positive(env.FREE2Z_TIMEOUT_MS, 120000),
    maxResponseBytes: positive(env.FREE2Z_MAX_RESPONSE_BYTES, 8 * 1024 * 1024),
    maxUploadBytes: positive(env.FREE2Z_MAX_UPLOAD_BYTES, 100 * 1024 * 1024),
  };
}
export function safeConfig(config: Config) {
  return {
    base_url: config.baseUrl,
    authentication: config.token
      ? "token"
      : config.session
        ? "session"
        : "anonymous",
    timeout_ms: config.timeoutMs,
    max_response_bytes: config.maxResponseBytes,
    max_upload_bytes: config.maxUploadBytes,
  };
}
export function redact(value: unknown, config: Config): unknown {
  const secrets = [
    config.token,
    config.session?.sessionid,
    config.session?.csrftoken,
  ].filter((s): s is string => Boolean(s));
  const walk = (item: any): any => {
    if (typeof item === "string") {
      for (const secret of secrets)
        item = item.split(secret).join("[REDACTED]");
      return item;
    }
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).map(([key, val]) => [
          key,
          /^(?:token|auth_token|access_token|refresh_token|id_token|password|old_password|new_password[12]?|secret|client_secret|code_verifier|sessionid|csrftoken|authorization|cookie|set-cookie|otp_token|recovery_codes|keep_token)$/i.test(
            key,
          )
            ? "[REDACTED]"
            : walk(val),
        ]),
      );
    return item;
  };
  return walk(value);
}
