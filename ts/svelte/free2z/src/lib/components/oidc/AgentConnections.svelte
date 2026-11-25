<script lang="ts">
  import { formatDateTime } from "$lib/utils/date";
  import { onMount, tick } from "svelte";
  import { tStore as t, getCurrentLocale } from "$lib/i18n";
  import { Label } from "$lib/components/ui/label";
  import { Button } from "$lib/components/ui/button";
  import {
    scopeLabel,
    agentActionLabel,
    agentActionStatus,
  } from "$lib/oidc/labels";
  import {
    agentRequest,
    type AgentConnections,
    type AgentConnection,
    type AgentAccount,
  } from "$lib/oidc/mcp";

  export let clientId: string | null | undefined = undefined;
  let data: AgentConnections = { connections: [], account_grants: [] };
  let status: "loading" | "ready" | "error" = "loading";
  let removing = false;
  let notice = "";
  let problem = "";
  let target: {
    kind: "connections" | "grants";
    id: string;
    label: string;
  } | null = null;
  let adding: AgentConnection | null = null;
  let username = "";
  let selectedScopes: string[] = [];
  let creatingLink = false;
  let linkUrl = "";
  let linkProblem = "";

  async function askAdd(connection: AgentConnection) {
    adding = connection;
    username = "";
    selectedScopes = connection.scopes.filter((scope) =>
      ["mcp:read", "mcp:write", "mcp:uploads"].includes(scope),
    );
    linkUrl = "";
    linkProblem = "";
    await tick();
    document.getElementById("agent-add-username")?.focus();
  }

  async function createLink() {
    if (!adding || creatingLink || linkUrl) return;
    creatingLink = true;
    linkProblem = "";
    try {
      const result = await agentRequest<{ url: string }>(
        `/api/oauth/mcp/connections/${encodeURIComponent(adding.id)}/link/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expected_username: username,
            scopes: selectedScopes,
          }),
        },
      );
      const url = new URL(result.url);
      if (
        url.pathname !== "/account/agent-link" ||
        url.search ||
        !/^#intent=[A-Za-z0-9_-]{43}$/.test(url.hash)
      )
        throw new Error();
      // Stay on this deployment's browser origin (including local previews).
      linkUrl = url.pathname + url.hash;
    } catch {
      linkProblem = $t(
        "oauth.agent.addFailed",
        "The account-link request could not be confirmed. No access is granted until the named account approves. Check Connected apps before trying again.",
      );
    } finally {
      creatingLink = false;
    }
  }
  $: connections = data.connections.filter(
    (item) =>
      !item.revoked &&
      (clientId === undefined || item.application.client_id === clientId),
  );
  $: grants = data.account_grants.filter(
    (item) =>
      !item.revoked &&
      (clientId === undefined || item.application.client_id === clientId),
  );

  async function load() {
    status = "loading";
    try {
      const response = await agentRequest<AgentConnections>(
        "/api/oauth/mcp/connections/",
      );
      if (
        !Array.isArray(response?.connections) ||
        !Array.isArray(response?.account_grants)
      ) {
        throw new Error("Invalid agent connections response");
      }
      data = response;
      status = "ready";
    } catch {
      status = "error";
    }
  }

  function askConnection(item: AgentConnection) {
    problem = "";
    target = { kind: "connections", id: item.id, label: item.application.name };
  }

  function askGrant(item: Pick<AgentAccount, "id" | "username">) {
    problem = "";
    target = { kind: "grants", id: item.id, label: `@${item.username}` };
  }

  async function remove() {
    if (!target || removing) return;
    const chosen = target;
    removing = true;
    problem = "";
    try {
      await agentRequest<void>(
        `/api/oauth/mcp/${chosen.kind}/${encodeURIComponent(chosen.id)}/`,
        { method: "DELETE" },
      );
      target = null;
      notice = $t("oauth.agent.removed", "Access removed.");
      await load();
    } catch {
      problem = $t(
        "oauth.agent.removeFailed",
        "Access could not be removed. Try again.",
      );
    } finally {
      removing = false;
    }
  }

  onMount(() => {
    void load();
  });
</script>

<section
  class="mt-8 space-y-4 border-t pt-6"
  aria-labelledby="agent-connections-title"
>
  <div class="space-y-1">
    <h2 id="agent-connections-title" class="text-xl font-semibold">
      {$t("oauth.agent.connections", "Agent connections")}
    </h2>
    <p class="text-sm text-muted-foreground">
      {$t(
        "oauth.agent.connectionsHelp",
        "Manage the accounts your assistants can use. Removing a connection removes its access to every linked account.",
      )}
    </p>
  </div>
  {#if notice}<p role="status" class="rounded-md border p-3 text-sm">
      {notice}
    </p>{/if}
  {#if status === "loading"}
    <p role="status">{$t("oauth.agent.loading", "Loading account access…")}</p>
  {:else if status === "error"}
    <div class="space-y-2">
      <p role="alert">
        {$t(
          "oauth.agent.loadFailed",
          "Agent account access could not be loaded.",
        )}
      </p>
      <Button variant="outline" onclick={load}
        >{$t("oauth.agent.retry", "Try again")}</Button
      >
    </div>
  {:else}
    {#each connections as connection (connection.id)}
      <article
        class="space-y-3 rounded-lg border bg-card p-4"
        data-testid="agent-connection"
      >
        <h3 class="font-semibold break-words">{connection.application.name}</h3>
        {#if connection.available === false}<p
            class="text-sm text-muted-foreground"
          >
            {$t("oauth.agent.unavailable", "Unavailable")}
          </p>{/if}
        <p class="text-sm break-words">
          {$t("oauth.agent.primary", "Connected by @{username}", {
            username: connection.primary_username,
          })}
        </p>
        <p class="text-xs break-all text-muted-foreground">
          {$t("oauth.agent.connectionId", "Connection ID")}:
          <code>{connection.id}</code>
        </p>
        <ul class="space-y-2 text-sm">
          {#each connection.accounts.filter((item) => !item.revoked) as account (account.id)}
            <li class="space-y-1 break-words">
              <span class="font-medium">@{account.username}</span>
              {#if !account.available}<span class="text-muted-foreground">
                  · {$t("oauth.agent.unavailable", "Unavailable")}</span
                >{/if}
              <ul class="list-inside list-disc text-muted-foreground">
                {#each account.scopes as scope}<li>
                    {scopeLabel($t, scope)}
                  </li>{/each}
              </ul>
              {#if account.username !== connection.primary_username}
                <Button variant="outline" onclick={() => askGrant(account)}>
                  {$t("oauth.agent.removeAccount", "Remove account access")}
                </Button>
              {/if}
            </li>
          {/each}
        </ul>
        {#if connection.available !== false}
          <Button
            variant="outline"
            onclick={() => askAdd(connection)}
            disabled={creatingLink}
          >
            {$t("oauth.agent.addAccount", "Add account")}
          </Button>
        {/if}
        {#if adding?.id === connection.id}
          <form
            class="space-y-4 rounded-lg border bg-card p-4"
            onsubmit={(event) => {
              event.preventDefault();
              void createLink();
            }}
            aria-label={$t("oauth.agent.addAccount", "Add account")}
          >
            <h3 class="font-semibold break-words">
              {$t("oauth.agent.addTo", "Add an account to {app}", {
                app: adding.application.name,
              })}
            </h3>
            <p class="text-sm">
              {$t(
                "oauth.agent.addHelp",
                "Enter the exact username. That account must sign in and approve access to this connection; creating a link grants no access.",
              )}
            </p>
            {#if linkUrl}
              <a
                href={linkUrl}
                class="font-medium text-primary underline"
                referrerpolicy="no-referrer"
              >
                {$t("oauth.agent.reviewLink", "Continue to account consent")}
              </a>
              <p class="text-sm text-muted-foreground">
                {$t(
                  "oauth.agent.linkExpiry",
                  "This link expires in 10 minutes. After approval, ask your assistant to list accounts again.",
                )}
              </p>
            {:else}
              <Label for="agent-add-username"
                >{$t(
                  "oauth.agent.exactUsername",
                  "Exact account username",
                )}</Label
              >
              <input
                id="agent-add-username"
                class="w-full rounded-md border bg-background px-3 py-2"
                bind:value={username}
                required
                maxlength={150}
                disabled={creatingLink}
                autocomplete="off"
                autocapitalize="none"
                spellcheck={false}
              />
              <fieldset class="space-y-2" disabled={creatingLink}>
                <legend class="mb-2 text-sm font-medium"
                  >{$t(
                    "oauth.agent.permissions",
                    "Allow this assistant to",
                  )}</legend
                >
                {#each adding.scopes.filter( (scope) => scope.startsWith("mcp:") ) as scope}
                  <Label control className="flex items-start gap-3 text-sm">
                    <input
                      type="checkbox"
                      value={scope}
                      bind:group={selectedScopes}
                      class="mt-0.5 h-4 w-4 shrink-0"
                    />
                    <span>{scopeLabel($t, scope)}</span>
                  </Label>
                {/each}
              </fieldset>
              <Button
                type="submit"
                disabled={creatingLink ||
                  !username ||
                  username !== username.trim() ||
                  selectedScopes.length === 0}
              >
                {$t("oauth.agent.createLink", "Create consent link")}
              </Button>
            {/if}
            {#if linkProblem}<p role="alert" class="text-sm text-destructive">
                {linkProblem}
              </p>{/if}
            <Button
              type="button"
              variant="outline"
              disabled={creatingLink}
              onclick={() => {
                adding = null;
                linkUrl = "";
              }}
            >
              {$t("oauth.agent.cancel", "Cancel")}
            </Button>
          </form>
        {/if}
        <Button variant="outline" onclick={() => askConnection(connection)}
          >{$t("oauth.agent.removeConnection", "Remove connection")}</Button
        >
      </article>
    {/each}
    {#each grants as grant (grant.id)}
      <article
        class="space-y-3 rounded-lg border bg-card p-4"
        data-testid="agent-account-grant"
      >
        <h3 class="font-semibold break-words">
          @{grant.username} · {grant.application.name}
        </h3>
        <p class="text-sm break-words">
          {$t("oauth.agent.primary", "Connected by @{username}", {
            username: grant.primary_username,
          })}
        </p>
        <ul class="list-inside list-disc text-sm text-muted-foreground">
          {#each grant.scopes as scope}<li>{scopeLabel($t, scope)}</li>{/each}
        </ul>
        {#if !grant.available}<p class="text-sm text-muted-foreground">
            {$t("oauth.agent.unavailable", "Unavailable")}
          </p>{/if}
        <Button variant="outline" onclick={() => askGrant(grant)}
          >{$t("oauth.agent.removeAccount", "Remove account access")}</Button
        >
      </article>
    {/each}
    {#if connections.length === 0 && grants.length === 0}<p
        class="text-sm text-muted-foreground"
      >
        {$t("oauth.agent.empty", "No agent connections for this account.")}
      </p>{/if}
  {/if}
  {#if status === "ready" && clientId === undefined && data.recent_actions?.length}
    <div class="space-y-3">
      <h3 class="font-semibold">
        {$t("oauth.agent.activity", "Recent agent activity")}
      </h3>
      <ul class="divide-y rounded-lg border text-sm">
        {#each data.recent_actions as action (action.id)}
          <li class="space-y-1 p-3 break-words" data-testid="agent-activity">
            <p class="font-medium">
              {action.target_username
                ? `@${action.target_username}`
                : $t("oauth.agent.deletedAccount", "Deleted account")} · {agentActionLabel(
                $t,
                action.operation,
              )}
            </p>
            <p class="text-muted-foreground">
              {action.application ??
                $t("oauth.agent.removedApplication", "Removed application")} · {agentActionStatus(
                $t,
                action.status,
              )}
            </p>
            <time datetime={action.created_at} class="text-muted-foreground"
              >{formatDateTime(action.created_at, getCurrentLocale(), {
                dateStyle: "medium",
                timeStyle: "short",
              })}</time
            >
          </li>
        {/each}
      </ul>
    </div>
  {/if}
  {#if target}
    <div
      class="space-y-3 rounded-lg border bg-muted/40 p-4"
      role="region"
      aria-label={$t("oauth.agent.confirmRemoval", "Confirm access removal")}
    >
      <p class="font-medium break-words">
        {$t("oauth.agent.removeNamed", "Remove access for {name}?", {
          name: target.label,
        })}
      </p>
      {#if target.kind === "connections"}<p class="text-sm">
          {$t(
            "oauth.agent.removeAllHelp",
            "The assistant will lose access to every account linked to this connection.",
          )}
        </p>{/if}
      {#if problem}<p role="alert" class="text-sm text-destructive">
          {problem}
        </p>{/if}
      <div class="flex flex-wrap gap-2">
        <Button variant="destructive" disabled={removing} onclick={remove}
          >{$t("oauth.agent.confirmRemove", "Remove access")}</Button
        >
        <Button
          variant="outline"
          disabled={removing}
          onclick={() => {
            target = null;
          }}>{$t("oauth.agent.cancel", "Cancel")}</Button
        >
      </div>
    </div>
  {/if}
</section>
