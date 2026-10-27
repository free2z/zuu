export class BackendBridgeError extends Error {
  public readonly code:
    | "missing-session"
    | "missing-csrf"
    | "untrusted-origin"
    | "invalid-configuration"
    | "invalid-destination";

  constructor(
    code:
      | "missing-session"
      | "missing-csrf"
      | "untrusted-origin"
      | "invalid-configuration"
      | "invalid-destination",
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "BackendBridgeError";
  }
}

export type BackendMutationMethod = "POST" | "PATCH" | "PUT" | "DELETE";

function normalizedOrigin(
  value: string,
  errorCode: BackendBridgeError["code"],
) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BackendBridgeError(errorCode, "Origin is not a valid URL.");
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new BackendBridgeError(
      errorCode,
      "Origin must be an HTTP(S) origin.",
    );
  }

  return url.origin;
}

function isLoopbackOrigin(origin: string) {
  const hostname = new URL(origin).hostname;
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

export function resolveBackendApiUrl(apiBase: string, path: string) {
  const baseOrigin = normalizedOrigin(
    apiBase.replace(/\/$/, ""),
    "invalid-configuration",
  );

  if (!path.startsWith("/api/")) {
    throw new BackendBridgeError(
      "invalid-destination",
      "Backend mutations are restricted to /api/ paths.",
    );
  }

  const target = new URL(path, `${baseOrigin}/`);
  if (target.origin !== baseOrigin || !target.pathname.startsWith("/api/")) {
    throw new BackendBridgeError(
      "invalid-destination",
      "Backend mutation destination is outside the configured API.",
    );
  }

  return target.toString();
}

export function assertTrustedRequestOrigin(
  requestDestinationOrigin: string,
  initiatingOrigin: string,
  configuredOrigins: string,
  apiBase: string,
) {
  const destinationOrigin = normalizedOrigin(
    requestDestinationOrigin,
    "untrusted-origin",
  );
  const browserOrigin = normalizedOrigin(initiatingOrigin, "untrusted-origin");

  // `url.origin` identifies where the request arrived, not who initiated it.
  // Require the browser's Origin to agree before minting a trusted Origin for
  // Django, so this bridge remains safe even if an upstream CSRF/CORS guard is
  // weakened or bypassed by a future request type.
  if (browserOrigin !== destinationOrigin) {
    throw new BackendBridgeError(
      "untrusted-origin",
      "The initiating origin does not match the public request destination.",
    );
  }
  const configured = configuredOrigins
    .split(",")
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .map((candidate) => normalizedOrigin(candidate, "invalid-configuration"));

  // Local development is safe by default because its browser and API origins
  // are normally identical. Deployed internal routing intentionally differs
  // and must provide PRIVATE_BACKEND_TRUSTED_ORIGINS explicitly.
  const allowed = configured.length
    ? configured
    : [normalizedOrigin(apiBase.replace(/\/$/, ""), "invalid-configuration")];

  // Vite and Django normally use different localhost ports in development.
  // Permit that loopback-only topology without making a missing production
  // allowlist fail open for a public hostname.
  if (
    configured.length === 0 &&
    isLoopbackOrigin(destinationOrigin) &&
    isLoopbackOrigin(allowed[0])
  ) {
    return destinationOrigin;
  }

  if (!allowed.includes(destinationOrigin)) {
    throw new BackendBridgeError(
      "untrusted-origin",
      "The public request origin is not trusted for backend mutations.",
    );
  }

  return destinationOrigin;
}

export function buildBackendMutationRequest({
  apiBase,
  configuredOrigins,
  requestDestinationOrigin,
  initiatingOrigin,
  path,
  method,
  sessionId,
  csrfToken,
  json,
}: {
  apiBase: string;
  configuredOrigins: string;
  requestDestinationOrigin: string;
  initiatingOrigin: string;
  path: string;
  method: BackendMutationMethod;
  sessionId?: string;
  csrfToken?: string;
  json?: unknown;
}) {
  if (!sessionId) {
    throw new BackendBridgeError(
      "missing-session",
      "Session cookie is missing.",
    );
  }
  if (!csrfToken) {
    throw new BackendBridgeError("missing-csrf", "CSRF cookie is missing.");
  }

  const origin = assertTrustedRequestOrigin(
    requestDestinationOrigin,
    initiatingOrigin,
    configuredOrigins,
    apiBase,
  );
  const target = resolveBackendApiUrl(apiBase, path);
  const headers = new Headers({
    Accept: "application/json",
    Cookie: `sessionid=${sessionId}; csrftoken=${csrfToken}`,
    Origin: origin,
    "X-CSRFToken": csrfToken,
  });

  if (json !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  return {
    target,
    init: {
      method,
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
      redirect: "manual" as const,
    },
  };
}
