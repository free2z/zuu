import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
export type Config = {
  baseUrl: string;
  token?: string;
  session?: { sessionid: string; csrftoken: string };
  accountsFile?: string;
  timeoutMs: number;
  maxResponseBytes: number;
  maxUploadBytes: number;
};
function secretFile(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd);
    if (
      !st.isFile() ||
      st.size > 65536 ||
      (process.platform !== "win32" && (st.mode & 0o077) !== 0)
    )
      throw new Error();
    const bytes = Buffer.alloc(65537);
    let size = 0;
    while (size < bytes.length) {
      const n = readSync(fd, bytes, size, bytes.length - size, null);
      if (n === 0) break;
      size += n;
    }
    if (size > 65536) throw new Error();
    return bytes.subarray(0, size).toString("utf8").trim();
  } catch {
    throw new Error(
      "Cannot read private credential file. Use a regular file at most 64 KiB, with chmod 600 on POSIX systems.",
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
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
    env.FREE2Z_ACCOUNTS_FILE,
  ].filter((value) => value !== undefined);
  if (modes.length > 1)
    throw new Error(
      "Configure exactly one of FREE2Z_TOKEN, FREE2Z_TOKEN_FILE, FREE2Z_SESSION_FILE or FREE2Z_ACCOUNTS_FILE.",
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
  const config: Config = {
    baseUrl: url.origin,
    token,
    session,
    accountsFile: env.FREE2Z_ACCOUNTS_FILE,
    timeoutMs: positive(env.FREE2Z_TIMEOUT_MS, 120000),
    maxResponseBytes: positive(env.FREE2Z_MAX_RESPONSE_BYTES, 8 * 1024 * 1024),
    maxUploadBytes: positive(env.FREE2Z_MAX_UPLOAD_BYTES, 100 * 1024 * 1024),
  };
  if (config.accountsFile !== undefined) readAccounts(config);
  return config;
}
type Account = { username: string; session_file?: string; token_file?: string };
function readAccounts(config: Config): Map<string, Account> {
  try {
    if (!config.accountsFile || !isAbsolute(config.accountsFile))
      throw new Error();
    const registry = JSON.parse(secretFile(config.accountsFile));
    if (
      !registry ||
      typeof registry !== "object" ||
      Array.isArray(registry) ||
      Object.keys(registry).length !== 1 ||
      !registry.accounts ||
      typeof registry.accounts !== "object" ||
      Array.isArray(registry.accounts)
    )
      throw new Error();
    const accounts = new Map<string, Account>();
    for (const [alias, value] of Object.entries(registry.accounts)) {
      const a = value as Account;
      if (
        !/^[A-Za-z0-9_-]{1,64}$/.test(alias) ||
        ["anonymous", "__proto__", "constructor", "prototype"].includes(
          alias,
        ) ||
        !a ||
        typeof a !== "object" ||
        Array.isArray(a) ||
        typeof a.username !== "string" ||
        !/^[^\s\x00-\x1f\x7f]{1,150}$/.test(a.username) ||
        Object.keys(a).some(
          (k) => !["username", "session_file", "token_file"].includes(k),
        ) ||
        Number(Object.hasOwn(a, "session_file")) +
          Number(Object.hasOwn(a, "token_file")) !==
          1
      )
        throw new Error();
      const path = a.session_file ?? a.token_file;
      if (typeof path !== "string" || !isAbsolute(path)) throw new Error();
      accounts.set(alias, a);
    }
    return accounts;
  } catch {
    throw new Error(
      "Invalid private accounts registry. Expected accounts mapping aliases to username and exactly one absolute session_file or token_file; anonymous is reserved.",
    );
  }
}
export function listAccounts(config: Config) {
  return config.accountsFile !== undefined
    ? {
        mode: "profiles",
        accounts: [
          ...[...readAccounts(config)].map(([account, a]) => ({
            account,
            username: a.username,
            authentication: a.session_file ? "session" : "token",
          })),
          { account: "anonymous", username: null, authentication: "anonymous" },
        ],
      }
    : {
        mode: "legacy",
        authentication: safeConfig(config).authentication,
        accounts: [
          { account: "anonymous", username: null, authentication: "anonymous" },
        ],
      };
}
export function resolveAccount(
  config: Config,
  account?: string,
): { config: Config; account?: string; username?: string } {
  if (config.accountsFile === undefined) {
    if (account === undefined) return { config };
    if (account !== "anonymous")
      throw new Error("Named accounts require FREE2Z_ACCOUNTS_FILE.");
    return {
      config: { ...config, token: undefined, session: undefined },
      account,
    };
  }
  const accounts = readAccounts(config);
  if (account === undefined)
    throw new Error(
      "Select an explicit account. Call free2z_list_accounts; no default account is used.",
    );
  if (account === "anonymous")
    return {
      config: { ...config, token: undefined, session: undefined },
      account,
    };
  const selected = accounts.get(account);
  if (!selected)
    throw new Error(
      "Unknown account. Call free2z_list_accounts; no fallback account is used.",
    );
  // Read once per call, then retain these credentials for both verification and execution.
  const credentials = loadConfig(
    selected.session_file !== undefined
      ? { FREE2Z_SESSION_FILE: selected.session_file }
      : { FREE2Z_TOKEN_FILE: selected.token_file },
  );
  return {
    config: {
      ...config,
      token: credentials.token,
      session: credentials.session,
    },
    account,
    username: selected.username,
  };
}
export function safeConfig(config: Config) {
  return {
    base_url: config.baseUrl,
    authentication:
      config.accountsFile !== undefined
        ? "profiles"
        : config.token
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
