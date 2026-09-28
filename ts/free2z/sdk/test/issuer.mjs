import { generateKeyPairSync, sign, createHash } from "node:crypto";
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "test",
  use: "sig",
  alg: "RS256",
};
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
export function issuer(extra = {}) {
  const origin = "https://issuer.example";
  let nonce,
    subject = "alice";
  let refreshCalls = 0,
    signIns = 0;
  const revocations = [],
    requests = [];
  let refreshHandler, apiHandler, authHandler;
  const jwt = (access, overrides = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const encoded =
      b64({ alg: "RS256", kid: "test" }) +
      "." +
      b64({
        iss: origin,
        sub: subject,
        aud: "client",
        iat: now,
        exp: now + 300,
        nonce,
        at_hash: createHash("sha256")
          .update(access)
          .digest()
          .subarray(0, 16)
          .toString("base64url"),
        ...overrides,
      });
    return (
      encoded +
      "." +
      sign("RSA-SHA256", Buffer.from(encoded), privateKey).toString("base64url")
    );
  };
  const json = (value, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
  const config = {
    clientId: "client",
    redirectUri: "https://app.example/callback",
    issuer: origin,
    apiBase: origin + "/api/sdk/v1",
    aiBase: origin + "/v1",
    requestTimeoutMs: 1000,
    authSession: {
      open() {
        return {
          async authorize(url) {
            const parsed = new URL(url);
            nonce = parsed.searchParams.get("nonce");
            if (authHandler) return authHandler(parsed);
            const callback = new URL("https://app.example/callback");
            callback.searchParams.set("code", "code");
            callback.searchParams.set(
              "state",
              parsed.searchParams.get("state"),
            );
            callback.searchParams.set("iss", origin);
            return callback.href;
          },
          close() {},
        };
      },
    },
    fetch: async (input, init = {}) => {
      const url = String(input),
        path = new URL(url).pathname;
      requests.push({ path, init });
      if (path === "/.well-known/openid-configuration")
        return json({
          issuer: origin,
          authorization_endpoint: origin + "/authorize",
          token_endpoint: origin + "/token",
          jwks_uri: origin + "/jwks",
          revocation_endpoint: origin + "/revoke",
          code_challenge_methods_supported: ["S256"],
          id_token_signing_alg_values_supported: ["RS256"],
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      if (path === "/jwks") return json({ keys: [jwk] });
      if (path === "/revoke") {
        revocations.push(new URLSearchParams(init.body).get("token"));
        return new Response("", { status: 200 });
      }
      if (path === "/token") {
        const params = new URLSearchParams(init.body);
        if (params.get("grant_type") === "refresh_token") {
          refreshCalls++;
          if (refreshHandler) return refreshHandler(params, init);
          return json({
            access_token: "access-rotated",
            refresh_token: "refresh-rotated",
            token_type: "Bearer",
            expires_in: 300,
          });
        }
        signIns++;
        const access = "access-" + signIns;
        return json({
          access_token: access,
          refresh_token: "refresh-" + signIns,
          token_type: "Bearer",
          expires_in: 300,
          scope:
            "openid profile offline_access balance:read purchase:create ai:invoke",
          id_token: jwt(access, extra.claims),
        });
      }
      if (apiHandler) return apiHandler(path, init);
      throw new Error("unexpected mock URL " + path);
    },
    ...extra.config,
  };
  return {
    config,
    json,
    jwt,
    requests,
    revocations,
    get refreshCalls() {
      return refreshCalls;
    },
    set refresh(fn) {
      refreshHandler = fn;
    },
    set api(fn) {
      apiHandler = fn;
    },
    set authorize(fn) {
      authHandler = fn;
    },
    set subject(value) {
      subject = value;
    },
  };
}
