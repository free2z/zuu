<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { tStore as t } from "$lib/i18n";
  import { Button } from "$lib/components/ui/button";
  import { Label } from "$lib/components/ui/label";
  import { apiFetch } from "$lib/api/config";
  import { loginDestination } from "$lib/login-destination";
  import { scopeLabel } from "$lib/oidc/labels";
  import {
    agentRequest,
    AgentRequestError,
    type AgentLinkPrompt,
  } from "$lib/oidc/mcp";
  import {
    clearAgentLinkIntent,
    takeAgentLinkIntent,
  } from "$lib/oidc/agent-link-intent";

  let intent: string | null = null;
  let prompt: AgentLinkPrompt | null = null;
  let selected: string[] = [];
  let phase:
    | "loading"
    | "signin"
    | "consent"
    | "submitting"
    | "complete"
    | "denied"
    | "invalid"
    | "error" = "loading";
  let message = "";
  let switching = false;

  function clearIntent() {
    try {
      clearAgentLinkIntent(window.sessionStorage);
    } catch {
      /* Storage unavailable. */
    }
    intent = null;
  }

  function signIn() {
    window.location.assign(loginDestination("/account/agent-link"));
  }

  async function load() {
    if (!intent) {
      phase = "invalid";
      return;
    }
    phase = "loading";
    message = "";
    try {
      prompt = await agentRequest<AgentLinkPrompt>(
        "/api/oauth/mcp/link/evaluate/",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ intent }),
        },
      );
      selected = [...prompt.scopes];
      phase = "consent";
    } catch (error) {
      if (error instanceof AgentRequestError && error.status === 401)
        phase = "signin";
      else if (
        error instanceof AgentRequestError &&
        [400, 404, 410].includes(error.status)
      ) {
        clearIntent();
        phase = "invalid";
      } else phase = "error";
    }
  }

  async function switchAccount() {
    switching = true;
    message = "";
    try {
      const response = await apiFetch("/api/auth/logout/", {
        method: "POST",
        referrerPolicy: "no-referrer",
      });
      if (!response.ok && response.status !== 401) throw new Error();
      signIn();
    } catch {
      message = $t(
        "oauth.agent.switchFailed",
        "Could not sign out. Try again before switching accounts.",
      );
      switching = false;
    }
  }

  async function decide(allow: boolean) {
    if (!intent || !prompt || phase !== "consent" || !prompt.account_matches)
      return;
    phase = "submitting";
    message = "";
    try {
      const result = await agentRequest<{ linked: boolean }>(
        "/api/oauth/mcp/link/",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            intent,
            allow,
            ...(allow ? { scopes: selected } : {}),
          }),
        },
      );
      if (result.linked !== allow) throw new Error();
      clearIntent();
      phase = allow ? "complete" : "denied";
    } catch (error) {
      if (error instanceof AgentRequestError && error.status === 401)
        phase = "signin";
      else if (
        error instanceof AgentRequestError &&
        [400, 404, 410].includes(error.status)
      ) {
        clearIntent();
        phase = "invalid";
      } else {
        // A session may have changed in another tab. Re-read identity and consent;
        // never repeat the approval automatically.
        await load();
        message = $t(
          "oauth.agent.decisionFailed",
          "The connection could not be confirmed. Check Connected apps before starting a new request.",
        );
      }
    }
  }

  async function initialize() {
    try {
      const originalUrl = new URL(window.location.href);
      if (originalUrl.hash || originalUrl.search) {
        await goto("/account/agent-link", {
          state: {},
          shallow: true,
          replace: true,
        });
      }
      // Clean the URL before touching storage, which can itself be disabled.
      intent = takeAgentLinkIntent(
        originalUrl,
        window.sessionStorage,
        () => {},
      );
    } catch {
      intent = null;
    }
    await load();
  }

  onMount(() => {
    void initialize();
  });
</script>

<svelte:head>
  <title>{$t("oauth.agent.linkTitle", "Connect an account · Free2Z")}</title>
  <meta name="referrer" content="no-referrer" />
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

<main class="mx-auto w-full max-w-xl space-y-6 px-4 py-8 sm:py-12">
  <header class="space-y-2">
    <p class="text-sm font-semibold text-primary">Free2Z</p>
    <h1 class="text-2xl font-semibold">
      {$t("oauth.agent.linkHeading", "Connect an account to an assistant")}
    </h1>
  </header>
  {#if phase === "loading"}
    <p role="status">{$t("oauth.agent.loading", "Loading account access…")}</p>
  {:else if phase === "signin"}
    <p>
      {$t(
        "oauth.agent.signInHelp",
        "Sign in to the Free2Z account you want to connect. You will review access before approving.",
      )}
    </p>
    <Button onclick={signIn}>{$t("oauth.agent.signIn", "Sign in")}</Button>
  {:else if phase === "invalid"}
    <p role="alert">
      {$t(
        "oauth.agent.invalid",
        "This request is missing or expired. If you already approved it, check Connected apps before asking the connection owner for a new link.",
      )}
    </p>
    <a href="/account/apps" class="font-medium text-primary underline">
      {$t("oauth.agent.manageAccess", "Open Connected apps")}
    </a>
  {:else if phase === "error"}
    <p role="alert">
      {$t(
        "oauth.agent.loadFailed",
        "Agent account access could not be loaded.",
      )}
    </p>
    <Button variant="outline" onclick={load}
      >{$t("oauth.agent.retry", "Try again")}</Button
    >
  {:else if phase === "complete" || phase === "denied"}
    <div class="space-y-2 rounded-lg border bg-card p-5" role="status">
      <h2 class="text-lg font-semibold">
        {phase === "complete"
          ? $t("oauth.agent.connected", "Account connected")
          : $t("oauth.agent.denied", "Connection declined")}
      </h2>
      <p>
        {$t(
          "oauth.agent.return",
          "You can close this tab. The connection owner can continue in their assistant.",
        )}
      </p>
    </div>
  {:else if prompt}
    <div class="space-y-4 rounded-lg border bg-card p-5">
      <dl class="space-y-3 text-sm">
        <div>
          <dt class="text-muted-foreground">
            {$t("oauth.agent.application", "Assistant application")}
          </dt>
          <dd class="font-semibold break-words">{prompt.application.name}</dd>
        </div>
        <div>
          <dt class="text-muted-foreground">
            {$t("oauth.agent.connectionOwner", "Connection owner")}
          </dt>
          <dd class="font-medium break-words">
            @{prompt.connection.primary_username}
          </dd>
        </div>
        <div>
          <dt class="text-muted-foreground">
            {$t("oauth.agent.requestedAccount", "Account to connect")}
          </dt>
          <dd class="text-lg font-semibold break-words">
            @{prompt.expected_username}
          </dd>
        </div>
        <div>
          <dt class="text-muted-foreground">
            {$t("oauth.agent.signedIn", "Signed in as")}
          </dt>
          <dd class="font-medium break-words">@{prompt.signed_in_username}</dd>
        </div>
      </dl>
      {#if !prompt.account_matches}
        <p class="text-sm" role="alert">
          {$t(
            "oauth.agent.wrongAccount",
            "This request is for @{expected}. Sign in as that account to continue.",
            { expected: prompt.expected_username },
          )}
        </p>
        <Button variant="outline" disabled={switching} onclick={switchAccount}
          >{$t("oauth.agent.signInAs", "Sign in as @{username}", {
            username: prompt.expected_username,
          })}</Button
        >
      {:else}
        <fieldset
          disabled={phase === "submitting"}
          class="space-y-3 border-t pt-4"
        >
          <legend class="pt-4 font-medium"
            >{$t("oauth.agent.permissions", "Allow this assistant to")}</legend
          >
          {#each prompt.scopes as scope}
            <Label control className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                value={scope}
                bind:group={selected}
                class="mt-0.5 h-4 w-4 shrink-0"
              />
              <span
                >{scopeLabel($t, scope, prompt.scope_descriptions[scope])}</span
              >
            </Label>
          {/each}
        </fieldset>
        <p class="text-sm font-medium">
          {$t(
            "oauth.agent.delegation",
            "Allow the {application} connection owned by @{primary} to act as @{target} with these permissions.",
            {
              application: prompt.application.name,
              primary: prompt.connection.primary_username,
              target: prompt.expected_username,
            },
          )}
        </p>
        <p class="text-sm text-muted-foreground">
          {$t(
            "oauth.agent.revokeHelp",
            "You can remove this access later in Connected apps.",
          )}
        </p>
        <div class="flex flex-wrap gap-2">
          <Button
            disabled={phase === "submitting" || selected.length === 0}
            onclick={() => decide(true)}
            >{$t("oauth.agent.allow", "Allow access")}</Button
          >
          <Button
            variant="outline"
            disabled={phase === "submitting"}
            onclick={() => decide(false)}
            >{$t("oauth.agent.deny", "Decline")}</Button
          >
        </div>
      {/if}
    </div>
  {/if}
  {#if message}<p role="alert" class="text-sm text-destructive">
      {message}
    </p>{/if}
</main>
