/**
 * Plain-language copy for the OIDC pages: scopes, cap periods,
 * redirect URI problems. Literal `t()` keys on purpose, so the catalog
 * check in `tests/locale.test.mjs` sees every one of them.
 *
 * Wording rule: 2Z are platform credits. Nothing here calls them money,
 * a currency, or crypto.
 */
import type { TranslationFunction } from "$lib/i18n";
import { formatTuzis } from "$lib/utils/format-tuzis";
import type { CapPeriod, SpendCap } from "./consent";
import type { OriginVerdict } from "./developer";
import type { RedirectUriProblem } from "./redirect-uris";

/** A scope in plain language; the backend's own sentence for an unknown one. */
export function scopeLabel(
  t: TranslationFunction,
  scope: string,
  fallback?: string,
): string {
  switch (scope) {
    case "openid":
      return t("oauth.scopes.openid", "Sign you in with your Free2Z account");
    case "profile":
      return t(
        "oauth.scopes.profile",
        "See your username, display name and avatar",
      );
    case "email":
      return t("oauth.scopes.email", "See your email address");
    case "offline_access":
      return t(
        "oauth.scopes.offlineAccess",
        "Stay signed in when you are not using it",
      );
    case "balance:read":
      return t("oauth.scopes.balanceRead", "See your 2Z credit balance");
    case "purchase:create":
      return t(
        "oauth.scopes.purchaseCreate",
        "Start 2Z credit purchases for you to confirm",
      );
    case "ai:invoke":
      return t(
        "oauth.scopes.aiInvoke",
        "Use AI features that spend your 2Z credits; an app budget is optional",
      );
    case "mcp:social":
      return t(
        "oauth.scopes.mcpSocial",
        "Read and manage follows, blocks, mutes and comments",
      );
    case "mcp:account":
      return t(
        "oauth.scopes.mcpAccount",
        "Read private account details and conversations; manage notifications",
      );
    case "mcp:media":
      return t(
        "oauth.scopes.mcpMedia",
        "Download, edit and delete your stored files",
      );
    case "mcp:live":
      return t(
        "oauth.scopes.mcpLive",
        "Read and manage your livestream host session",
      );
    case "mcp:delete":
      return t(
        "oauth.scopes.mcpDelete",
        "Permanently delete your pages, translations, comments, conversations, collections and files",
      );
    case "mcp:spend":
      return t(
        "oauth.scopes.mcpSpend",
        "Spend 2Z on comments, votes and translations within each explicit limit",
      );
    case "mcp:ai":
      return t(
        "oauth.scopes.mcpAI",
        "Send prompts to AI providers and spend your 2Z credits up to each request’s quoted maximum",
      );
    case "mcp:read":
      return t(
        "oauth.scopes.mcpRead",
        "Read your public profile, pages and media",
      );
    case "mcp:write":
      return t(
        "oauth.scopes.mcpWrite",
        "Create/edit drafts and update your public profile",
      );
    case "mcp:publish":
      return t(
        "oauth.scopes.mcpPublish",
        "Publish or edit public pages and media",
      );
    case "mcp:uploads":
      return t("oauth.scopes.mcpUploads", "Upload files to your account");
    default:
      return fallback || scope;
  }
}

/** "per day", "per week", "per month", "in total". */
export function capPeriodLabel(
  t: TranslationFunction,
  period: CapPeriod,
): string {
  switch (period) {
    case "day":
      return t("oauth.capPeriods.day", "per day");
    case "week":
      return t("oauth.capPeriods.week", "per week");
    case "month":
      return t("oauth.capPeriods.month", "per month");
    case "total":
      return t("oauth.capPeriods.total", "in total");
  }
}

/** "1,000 2Z per month", or "Available balance (no extra budget)". */
export function capSummary(
  t: TranslationFunction,
  cap: SpendCap,
  locale?: string,
): string {
  if (cap.spend_cap_2z === null) {
    return t("oauth.cap.noLimit", "Available balance (no extra budget)");
  }
  return t("oauth.cap.amountPerPeriod", "{amount} 2Z {period}", {
    amount: formatTuzis(cap.spend_cap_2z, locale),
    period: capPeriodLabel(t, cap.cap_period),
  });
}

export function redirectProblemLabel(
  t: TranslationFunction,
  problem: RedirectUriProblem,
): string {
  switch (problem) {
    case "required":
      return t(
        "oauth.redirectUri.required",
        "Enter at least one redirect URI.",
      );
    case "whitespace":
      return t(
        "oauth.redirectUri.whitespace",
        "A redirect URI cannot contain spaces. Put each URI on its own line.",
      );
    case "fragment":
      return t(
        "oauth.redirectUri.fragment",
        "A redirect URI cannot contain a fragment (#…).",
      );
    case "query":
      return t(
        "oauth.redirectUri.query",
        "A redirect URI cannot contain a query string (?…); Free2Z appends its own.",
      );
    case "notAbsolute":
      return t(
        "oauth.redirectUri.notAbsolute",
        "Use an absolute URI with a scheme, such as https://app.example.com/callback.",
      );
    case "credentials":
      return t(
        "oauth.redirectUri.credentials",
        "A redirect URI cannot contain a username or password.",
      );
    case "localhost":
      return t(
        "oauth.redirectUri.localhost",
        "“localhost” is not accepted because it may resolve off the device. Use http://127.0.0.1:<port>/… or http://[::1]:<port>/… (RFC 8252 §8.3).",
      );
    case "httpNotLoopback":
      return t(
        "oauth.redirectUri.httpNotLoopback",
        "Plain http is accepted only for the loopback address (http://127.0.0.1:<port>/…). Use https everywhere else.",
      );
    case "badPort":
      return t("oauth.redirectUri.badPort", "The loopback port is not valid.");
    case "loopbackNoPath":
      return t(
        "oauth.redirectUri.loopbackNoPath",
        "A loopback redirect needs a path, such as http://127.0.0.1:0/callback.",
      );
    case "httpsNoHost":
      return t(
        "oauth.redirectUri.httpsNoHost",
        "An https redirect needs a host.",
      );
    case "httpsLoopback":
      return t(
        "oauth.redirectUri.httpsLoopback",
        "Loopback redirects use http, not https (RFC 8252 §7.3).",
      );
    case "badScheme":
      return t(
        "oauth.redirectUri.badScheme",
        "Use https, loopback http, or a reverse-DNS app scheme you control, such as com.example.app (RFC 8252 §7.1).",
      );
    case "privateSchemeSlashes":
      return t(
        "oauth.redirectUri.privateSchemeSlashes",
        "An app scheme takes one slash after the colon: com.example.app:/oauth/callback.",
      );
    case "privateSchemeNoPath":
      return t(
        "oauth.redirectUri.privateSchemeNoPath",
        "An app scheme redirect needs a path: com.example.app:/oauth/callback.",
      );
    case "confidentialHttpsOnly":
      return t(
        "oauth.redirectUri.confidentialHttpsOnly",
        "A server-side (confidential) app may only register https redirect URIs.",
      );
    case "duplicate":
      return t("oauth.redirectUri.duplicate", "This URI is listed twice.");
  }
}

/** Why an allowed-origin line is refused; `null` when it is fine. */
export function originProblemLabel(
  t: TranslationFunction,
  verdict: OriginVerdict,
): string | null {
  if (verdict.ok) return null;
  switch (verdict.problem) {
    case "whitespace":
      return t(
        "oauth.origin.whitespace",
        "An origin cannot contain spaces. Put each origin on its own line.",
      );
    case "query":
      return t("oauth.origin.query", "An origin has no query string (?…).");
    case "fragment":
      return t("oauth.origin.fragment", "An origin has no fragment (#…).");
    case "notHttps":
      return t(
        "oauth.origin.notHttps",
        "Use an https origin, such as https://app.example.com.",
      );
    case "credentials":
      return t(
        "oauth.origin.credentials",
        "An origin cannot contain a username or password.",
      );
    case "path":
      return t(
        "oauth.origin.path",
        "An origin has no path, not even a trailing slash: https://app.example.com.",
      );
    case "noHost":
      return t("oauth.origin.noHost", "An origin needs a host.");
    case "sameSite":
      return t(
        "oauth.origin.sameSite",
        "Origins on Free2Z's own domains are not allowed: they would receive Free2Z's sign-in cookies.",
      );
    case "notCanonical":
      return t(
        "oauth.origin.notCanonical",
        "Write it exactly as the browser sends it: {origin}",
        { origin: verdict.canonical ?? "" },
      );
  }
}

/** Activity labels describe the action without exposing request content. */
export function agentActionLabel(
  t: TranslationFunction,
  operation: string,
): string {
  switch (operation) {
    case "list_pages":
      return t("oauth.agent.actions.listPages", "Browse pages");
    case "get_page":
      return t("oauth.agent.actions.getPage", "Read page");
    case "create_draft":
      return t("oauth.agent.actions.createDraft", "Create draft");
    case "update_page":
      return t("oauth.agent.actions.updatePage", "Edit page");
    case "set_page_published":
      return t(
        "oauth.agent.actions.setPagePublished",
        "Change page visibility",
      );
    case "get_profile":
      return t("oauth.agent.actions.getProfile", "Read public profile");
    case "update_profile":
      return t("oauth.agent.actions.updateProfile", "Edit public profile");
    case "list_uploads":
      return t("oauth.agent.actions.listUploads", "Browse media");
    case "get_upload":
      return t("oauth.agent.actions.getUpload", "Inspect media");
    case "prepare_upload":
      return t("oauth.agent.actions.prepareUpload", "Prepare upload");
    case "upload_file":
      return t("oauth.agent.actions.uploadFile", "Upload file");
    default:
      return t("oauth.agent.actions.unknown", "Account action");
  }
}

/** A server error cannot establish whether a write committed. */
export function agentActionStatus(
  t: TranslationFunction,
  status: number | string,
): string {
  const code = Number(status);
  if (Number.isInteger(code) && code >= 200 && code < 300)
    return t("oauth.agent.actionStatus.completed", "Completed");
  if (Number.isInteger(code) && code >= 400 && code < 500)
    return t("oauth.agent.actionStatus.notCompleted", "Not completed");
  return t("oauth.agent.actionStatus.uncertain", "Could not confirm");
}
