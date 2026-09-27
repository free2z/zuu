import * as oauth from "oauth4webapi";
import { PopupAuthSession, type BrowserAuthSession } from "./browser.js";
import {
  SdkError,
  cancelled,
  delay,
  failure,
  waitWithSignal,
} from "./error.js";
import { deadline, readBytes, secureUrl } from "./http.js";
import type { Session, SignInOptions } from "./types.js";

export const DEFAULT_SCOPES = [
  "openid",
  "profile",
  "offline_access",
  "balance:read",
  "purchase:create",
  "ai:invoke",
] as const;
export interface FetchConfig {
  clientId: string;
  redirectUri: string;
  /** Registered browser purchase-return route; defaults to redirectUri. */
  purchaseReturnUri?: string;
  issuer?: string;
  apiBase?: string;
  aiBase?: string;
  scopes?: readonly string[];
  requestTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  /** Test/development loopback only; never permits cleartext non-loopback hosts. */
  allowInsecureLoopback?: boolean;
  fetch?: typeof globalThis.fetch;
  authSession?: BrowserAuthSession;
  openExternal?: (url: string) => Promise<void>;
}
interface Tokens {
  access: string;
  refresh?: string;
  expires: number;
  subject: string;
  scopes: string[];
}
function safeError(error: unknown): SdkError {
  if (error instanceof SdkError) return error;
  if (error instanceof oauth.ResponseBodyError)
    return new SdkError(error.error);
  if (error instanceof oauth.AuthorizationResponseError)
    return new SdkError(error.error);
  if (
    error instanceof TypeError ||
    (error instanceof DOMException && error.name === "AbortError")
  )
    return new SdkError("transport");
  return new SdkError("invalid_response");
}
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
/** In-memory OAuth owner. Tokens are private and never placed in browser storage. */
export class WebSession {
  readonly issuer: URL;
  readonly redirect: URL;
  readonly timeout: number;
  readonly request: typeof globalThis.fetch;
  readonly config: FetchConfig;
  readonly client: oauth.Client;
  #tokens: Tokens | undefined;
  #generation = 0n;
  #discovery: Promise<oauth.AuthorizationServer> | undefined;
  #refresh: { generation: string; promise: Promise<string> } | undefined;
  constructor(config: FetchConfig) {
    if (!config.clientId || config.clientId.length > 512)
      failure("invalid_config");
    this.config = config;
    this.issuer = secureUrl(
      config.issuer ?? "https://free2z.cash",
      config.allowInsecureLoopback,
    );
    this.redirect = secureUrl(config.redirectUri, config.allowInsecureLoopback);
    if (this.issuer.search || this.redirect.search) failure("invalid_config");
    this.timeout = config.requestTimeoutMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > 3_600_000
    )
      failure("invalid_config");
    this.request = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.client = {
      client_id: config.clientId,
      id_token_signed_response_alg: "RS256",
      [oauth.clockTolerance]: 30,
    };
  }
  get generation(): string {
    return this.#generation.toString();
  }
  snapshot(): Session {
    return {
      signedIn: this.#tokens !== undefined,
      subject: this.#tokens?.subject ?? null,
      grantedScopes: [...(this.#tokens?.scopes ?? [])],
      persistence: "memory_only",
      generation: this.generation,
    };
  }
  #options(
    signal?: AbortSignal,
  ): oauth.HttpRequestOptions<string, URLSearchParams | undefined> {
    const options: oauth.HttpRequestOptions<
      string,
      URLSearchParams | undefined
    > = {
      [oauth.customFetch]: async (input, init) => {
        const target = secureUrl(input, this.config.allowInsecureLoopback);
        if (target.origin !== this.issuer.origin) failure("invalid_discovery");
        const bound = deadline(this.timeout, init?.signal ?? undefined);
        try {
          const response = await this.request(input, {
            method: init.method,
            headers: init.headers,
            body: init.body ?? null,
            signal: bound.signal,
            redirect: "error",
            credentials: "omit",
            referrerPolicy: "no-referrer",
          });
          const bytes = await readBytes(response, 512 * 1024, bound.signal);
          return new Response(bytes, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        } finally {
          bound.close();
        }
      },
    };
    if (signal) options.signal = signal;
    if (this.config.allowInsecureLoopback)
      options[oauth.allowInsecureRequests] = true;
    return options;
  }
  async discovery(): Promise<oauth.AuthorizationServer> {
    if (!this.#discovery) {
      this.#discovery = (async () => {
        const response = await oauth.discoveryRequest(
          this.issuer,
          this.#options(),
        );
        const as = await oauth.processDiscoveryResponse(this.issuer, response);
        for (const endpoint of [
          as.authorization_endpoint,
          as.token_endpoint,
          as.jwks_uri,
          as.revocation_endpoint,
        ]) {
          if (
            typeof endpoint !== "string" ||
            secureUrl(endpoint, this.config.allowInsecureLoopback).origin !==
              this.issuer.origin
          )
            failure("invalid_discovery");
        }
        if (
          !as.code_challenge_methods_supported?.includes("S256") ||
          !as.id_token_signing_alg_values_supported?.includes("RS256")
        )
          failure("invalid_discovery");
        // RFC9207 is mandatory for this profile even if metadata omitted the flag.
        return { ...as, authorization_response_iss_parameter_supported: true };
      })().catch((error) => {
        this.#discovery = undefined;
        throw safeError(error);
      });
    }
    return this.#discovery;
  }
  async #validate(
    as: oauth.AuthorizationServer,
    response: Response,
    tokens: oauth.TokenEndpointResponse,
    subject?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!tokens.id_token) {
      if (subject) return subject;
      failure("invalid_response");
    }
    await oauth.validateApplicationLevelSignature(
      as,
      response,
      this.#options(signal),
    );
    const claims = oauth.getValidatedIdTokenClaims(tokens);
    if (!claims || (subject !== undefined && claims.sub !== subject))
      failure("invalid_response");
    if (claims.at_hash !== undefined) {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(tokens.access_token),
      );
      if (claims.at_hash !== base64url(new Uint8Array(digest).slice(0, 16)))
        failure("invalid_response");
    }
    return claims.sub;
  }
  #install(
    tokens: oauth.TokenEndpointResponse,
    subject: string,
    previousScopes?: string[],
  ): void {
    if (tokens.token_type.toLowerCase() !== "bearer")
      failure("invalid_response");
    const scopes =
      tokens.scope === undefined
        ? previousScopes
        : tokens.scope.split(/ +/).filter(Boolean);
    if (!scopes) failure("invalid_response");
    const expires = tokens.expires_in ?? 300;
    if (!Number.isSafeInteger(expires) || expires <= 0 || expires > 86_400)
      failure("invalid_response");
    const next: Tokens = {
      access: tokens.access_token,
      expires: performance.now() + expires * 1000,
      subject,
      scopes,
    };
    if (tokens.refresh_token !== undefined) next.refresh = tokens.refresh_token;
    this.#tokens = next;
  }
  async signIn(options: SignInOptions = {}): Promise<Session> {
    cancelled(options.signal);
    const generation = this.generation;
    const attempt = (this.config.authSession ?? new PopupAuthSession()).open();
    let issued: oauth.TokenEndpointResponse | undefined;
    try {
      const as = await waitWithSignal(this.discovery(), options.signal);
      const verifier = oauth.generateRandomCodeVerifier(),
        state = oauth.generateRandomState(),
        nonce = oauth.generateRandomNonce();
      const scopes = [...(this.config.scopes ?? DEFAULT_SCOPES)];
      if (
        !scopes.includes("openid") ||
        scopes.some((scope) => !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope))
      )
        failure("invalid_config");
      const url = new URL(as.authorization_endpoint!);
      for (const [k, v] of Object.entries({
        client_id: this.client.client_id,
        redirect_uri: this.redirect.href,
        response_type: "code",
        scope: scopes.join(" "),
        code_challenge_method: "S256",
        code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
        state,
        nonce,
      }))
        url.searchParams.set(k, v);
      if (options.prompt) url.searchParams.set("prompt", options.prompt);
      if (options.acrValues)
        url.searchParams.set("acr_values", options.acrValues);
      if (options.maxAge !== undefined) {
        if (!Number.isSafeInteger(options.maxAge) || options.maxAge < 0)
          failure("invalid_request");
        url.searchParams.set("max_age", String(options.maxAge));
      }
      const callback = new URL(
        await attempt.authorize(url.href, this.redirect.href, options.signal),
      );
      if (
        callback.origin !== this.redirect.origin ||
        callback.pathname !== this.redirect.pathname ||
        callback.hash ||
        callback.username ||
        callback.password
      )
        failure("invalid_callback");
      const params = oauth.validateAuthResponse(
        as,
        this.client,
        callback,
        state,
      );
      cancelled(options.signal);
      if (generation !== this.generation) failure("signed_out");
      // Token exchange/validation completes independently once sent, so aborts
      // and sign-out can revoke the issued family instead of losing it.
      const response = await oauth.authorizationCodeGrantRequest(
        as,
        this.client,
        oauth.None(),
        params,
        this.redirect.href,
        verifier,
        this.#options(),
      );
      const processOptions: oauth.ProcessAuthorizationCodeResponseOptions = {
        expectedNonce: nonce,
        requireIdToken: true,
      };
      if (options.maxAge !== undefined) processOptions.maxAge = options.maxAge;
      issued = await oauth.processAuthorizationCodeResponse(
        as,
        this.client,
        response,
        processOptions,
      );
      const subject = await this.#validate(as, response, issued);
      cancelled(options.signal);
      if (generation !== this.generation) failure("signed_out");
      const old = this.#tokens?.refresh;
      this.#install(issued, subject);
      this.#generation++;
      issued = undefined;
      if (old) void this.revoke(old);
      return this.snapshot();
    } catch (error) {
      if (issued?.refresh_token) void this.revoke(issued.refresh_token);
      throw safeError(error);
    } finally {
      attempt.close();
    }
  }
  async revoke(token: string): Promise<boolean> {
    try {
      const as = await this.discovery();
      const response = await oauth.revocationRequest(
        as,
        this.client,
        oauth.None(),
        token,
        {
          ...this.#options(),
          additionalParameters: { token_type_hint: "refresh_token" },
        },
      );
      await oauth.processRevocationResponse(response);
      return true;
    } catch {
      return false;
    }
  }
  async signOut(): Promise<{ revoked: boolean; generation: string }> {
    const token = this.#tokens?.refresh;
    this.#tokens = undefined;
    this.#generation++;
    const generation = this.generation;
    return { revoked: token ? await this.revoke(token) : false, generation };
  }
  invalidate(generation: string): void {
    if (generation === this.generation) {
      this.#tokens = undefined;
      this.#generation++;
    }
  }
  async token(
    scope: string,
    generation: string,
    signal?: AbortSignal,
    force = false,
  ): Promise<string> {
    cancelled(signal);
    if (generation !== this.generation || !this.#tokens) failure("signed_out");
    if (!this.#tokens.scopes.includes(scope)) failure("insufficient_scope");
    if (!force && this.#tokens.expires > performance.now() + 30_000)
      return this.#tokens.access;
    if (this.#refresh?.generation !== generation) {
      const entry = { generation, promise: this.#rotate(generation) };
      this.#refresh = entry;
      void entry.promise
        .finally(() => {
          if (this.#refresh === entry) this.#refresh = undefined;
        })
        .catch(() => {});
    }
    const token = await waitWithSignal(this.#refresh.promise, signal);
    if (generation !== this.generation) failure("signed_out");
    cancelled(signal);
    return token;
  }
  async #rotate(generation: string): Promise<string> {
    const previous = this.#tokens;
    if (!previous?.refresh) {
      this.invalidate(generation);
      failure("signed_out");
    }
    const as = await this.discovery();
    const end = performance.now() + 55_000;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (generation !== this.generation) failure("signed_out");
      if (attempt > 0) await delay(200 * attempt);
      const remaining = end - performance.now();
      if (remaining <= 0) break;
      const bound = deadline(
        Math.min(remaining, attempt === 0 ? 30_000 : remaining),
      );
      let issued: oauth.TokenEndpointResponse | undefined;
      try {
        const response = await oauth.refreshTokenGrantRequest(
          as,
          this.client,
          oauth.None(),
          previous.refresh,
          this.#options(bound.signal),
        );
        if (response.status >= 500) failure("temporarily_unavailable");
        issued = await oauth.processRefreshTokenResponse(
          as,
          this.client,
          response,
        );
        await this.#validate(
          as,
          response,
          issued,
          previous.subject,
          bound.signal,
        );
        if (generation !== this.generation) {
          if (issued.refresh_token) void this.revoke(issued.refresh_token);
          failure("signed_out");
        }
        if (!issued.refresh_token) failure("invalid_response");
        this.#install(issued, previous.subject, previous.scopes);
        return issued.access_token;
      } catch (error) {
        const safe = safeError(error);
        if (
          ![
            "transport",
            "invalid_response",
            "cancelled",
            "server_error",
            "temporarily_unavailable",
          ].includes(safe.code)
        ) {
          if (issued?.refresh_token) void this.revoke(issued.refresh_token);
          this.invalidate(generation);
          throw safe;
        }
      } finally {
        bound.close();
      }
    }
    this.invalidate(generation);
    void this.revoke(previous.refresh);
    throw new SdkError("refresh_recovery_exhausted");
  }
}
