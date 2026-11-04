<script lang="ts">
  import EconomyPolicyNote from "$lib/components/EconomyPolicyNote.svelte";
  /**
   * The developer console (; zuu docs/free2z/sdk/spec/oidc.md §2, §3).
   *
   * Register, edit and delete your own apps. Nothing an operator alone may
   * set is editable here: the approved markup is set by Free2Z by hand, so
   * a requested markup above it shows as pending and applies to nobody. A
   * confidential client's secret is shown exactly once — on registration or
   * rotation — and is never readable again.
   */
  import { onMount, tick } from "svelte";
  import { tStore as t, getCurrentLocale } from "$lib/i18n";
  import { Button } from "$lib/components/ui/button";
  import * as Dialog from "$lib/components/ui/dialog";
  import {
    oidcDeveloperAppDestroy,
    oidcDeveloperAppRotateSecret,
    oidcDeveloperAppUpdate,
    oidcDeveloperAppsCreate,
    oidcDeveloperAppsList,
  } from "$lib/api/oauth/oauth";
  import type { DeveloperApp, PatchedDeveloperApp } from "$lib/api/f2z.schemas";
  import { ApiError } from "$lib/api/mutator";
  import { loginDestination } from "$lib/login-destination";
  import { copyToClipboard } from "$lib/utils/clipboard";
  import { CAP_PERIODS, markupPercent } from "$lib/oidc/consent";
  import {
    ALL_SCOPES,
    MARKUP_CAP_BPS,
    emptyForm,
    formFromApp,
    lines,
    payloadFromForm,
    validateOrigins,
    type AppForm,
    type FormProblem,
  } from "$lib/oidc/developer";
  import { validateRedirectUris } from "$lib/oidc/redirect-uris";
  import {
    capPeriodLabel,
    originProblemLabel,
    redirectProblemLabel,
    scopeLabel,
  } from "$lib/oidc/labels";

  let apps: DeveloperApp[] = [];
  let status: "loading" | "ready" | "error" = "loading";

  let formOpen = false;
  let editing: DeveloperApp | null = null;
  let form: AppForm = emptyForm();
  let formProblems: FormProblem[] = [];
  let serverErrors: Record<string, string[]> = {};
  let saving = false;
  let saveError = "";
  let notice = "";

  let secret: { appName: string; value: string } | null = null;
  let secretOpen = false;
  let copied = false;

  let deleteTarget: DeveloperApp | null = null;
  let deleteOpen = false;
  let deleting = false;
  let deleteError = "";

  let rotateTarget: DeveloperApp | null = null;
  let rotateOpen = false;
  let rotating = false;
  let rotateError = "";

  $: locale = getCurrentLocale();
  $: uriLines = validateRedirectUris(lines(form.redirectUris), form.clientType);
  $: uriProblems = uriLines.filter((line) => !line.verdict.ok);
  //an origin is judged line by line before a round trip, the way
  // the server's registration policy judges it.
  $: originLines =
    form.clientType === "public"
      ? validateOrigins(lines(form.allowedOrigins))
      : [];
  $: markupCapPercent = markupPercent(MARKUP_CAP_BPS, locale);

  function signInAgain() {
    window.location.assign(loginDestination("/developers/apps"));
  }

  function isAuthFailure(error: unknown): boolean {
    return (
      error instanceof ApiError &&
      (error.status === 401 || error.status === 403)
    );
  }

  /** `{field: [sentences]}` from a DRF 400, list-index errors flattened. */
  function fieldMessages(data: unknown): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    if (!data || typeof data !== "object" || Array.isArray(data)) return out;
    const flatten = (value: unknown): string[] => {
      if (typeof value === "string") return [value];
      if (Array.isArray(value)) return value.flatMap(flatten);
      if (value && typeof value === "object") {
        return Object.values(value).flatMap(flatten);
      }
      return [];
    };
    for (const [key, value] of Object.entries(data)) {
      const messages = flatten(value);
      if (messages.length) out[key] = messages;
    }
    return out;
  }

  async function load() {
    status = "loading";
    try {
      apps = await oidcDeveloperAppsList();
      status = "ready";
    } catch (error) {
      if (isAuthFailure(error)) {
        signInAgain();
        return;
      }
      status = "error";
    }
  }

  async function openCreate() {
    editing = null;
    form = emptyForm();
    formProblems = [];
    serverErrors = {};
    saveError = "";
    formOpen = true;
    await tick();
    document.getElementById("dev-app-name")?.focus();
  }

  async function openEdit(app: DeveloperApp) {
    editing = app;
    form = formFromApp(app as never);
    formProblems = [];
    serverErrors = {};
    saveError = "";
    formOpen = true;
    await tick();
    document.getElementById("dev-app-name")?.focus();
  }

  function closeForm() {
    formOpen = false;
    editing = null;
  }

  function toggleScope(scope: string, checked: boolean) {
    const set = new Set(form.allowedScopes);
    if (checked) set.add(scope);
    else set.delete(scope);
    form = { ...form, allowedScopes: [...set] };
  }

  async function save() {
    saveError = "";
    serverErrors = {};
    const result = payloadFromForm(form, editing === null, editing as never);
    formProblems = result.ok ? [] : result.problems;
    if (!result.ok || uriProblems.length || uriLines.length === 0) {
      saveError = $t(
        "oauth.developerApps.fixErrors",
        "Fix the highlighted fields and try again.",
      );
      return;
    }
    saving = true;
    try {
      if (editing) {
        const updated = await oidcDeveloperAppUpdate(
          editing.id,
          result.payload as PatchedDeveloperApp,
        );
        apps = apps.map((a) => (a.id === updated.id ? updated : a));
        notice = $t("oauth.developerApps.saved", "{app} was saved.", {
          app: updated.name,
        });
      } else {
        const created = await oidcDeveloperAppsCreate(
          result.payload as unknown as DeveloperApp,
        );
        const { client_secret: createdSecret, ...app } = created;
        apps = [app as DeveloperApp, ...apps];
        notice = $t("oauth.developerApps.registered", "{app} was registered.", {
          app: created.name,
        });
        if (createdSecret) {
          secret = { appName: created.name, value: createdSecret };
          copied = false;
          secretOpen = true;
        }
      }
      closeForm();
    } catch (error) {
      if (isAuthFailure(error)) {
        signInAgain();
        return;
      }
      if (error instanceof ApiError && error.status === 400) {
        serverErrors = fieldMessages(error.data);
        saveError = $t(
          "oauth.developerApps.fixErrors",
          "Fix the highlighted fields and try again.",
        );
        return;
      }
      saveError = $t(
        "oauth.developerApps.saveFailed",
        "The app could not be saved. Please try again.",
      );
    } finally {
      saving = false;
    }
  }

  function askDelete(app: DeveloperApp) {
    deleteTarget = app;
    deleteError = "";
    deleteOpen = true;
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    deleting = true;
    deleteError = "";
    try {
      await oidcDeveloperAppDestroy(target.id);
      apps = apps.filter((a) => a.id !== target.id);
      notice = $t("oauth.developerApps.deleted", "{app} was deleted.", {
        app: target.name,
      });
      deleteOpen = false;
      deleteTarget = null;
      if (editing?.id === target.id) closeForm();
    } catch (error) {
      if (isAuthFailure(error)) {
        signInAgain();
        return;
      }
      if (error instanceof ApiError && error.status === 409) {
        deleteError = $t(
          "oauth.developerApps.deleteInUse",
          "People have connected this app, so it cannot be deleted. Contact support to retire it.",
        );
        return;
      }
      deleteError = $t(
        "oauth.developerApps.deleteFailed",
        "The app could not be deleted. Please try again.",
      );
    } finally {
      deleting = false;
    }
  }

  function askRotate(app: DeveloperApp) {
    rotateTarget = app;
    rotateError = "";
    rotateOpen = true;
  }

  async function confirmRotate() {
    if (!rotateTarget) return;
    const target = rotateTarget;
    rotating = true;
    rotateError = "";
    try {
      const rotated = await oidcDeveloperAppRotateSecret(target.id);
      rotateOpen = false;
      rotateTarget = null;
      secret = { appName: target.name, value: rotated.client_secret };
      copied = false;
      secretOpen = true;
    } catch (error) {
      if (isAuthFailure(error)) {
        signInAgain();
        return;
      }
      // Only a 4xx proves nothing was written. A timeout, a network error
      // or a 5xx may have committed the rotation with the answer lost, so
      // the old secret may already be dead (codex review, ).
      const refused =
        error instanceof ApiError && error.status >= 400 && error.status < 500;
      rotateError = refused
        ? $t(
            "oauth.developerApps.rotateFailed",
            "A new secret could not be issued. Your current secret still works.",
          )
        : $t(
            "oauth.developerApps.rotateUnknown",
            "Free2Z did not answer, so a new secret may have been issued and your current one may no longer work. Issue a new secret again and install the one it shows.",
          );
    } finally {
      rotating = false;
    }
  }

  async function copySecret() {
    if (!secret) return;
    copied = await copyToClipboard(secret.value);
  }

  function closeSecret() {
    secretOpen = false;
    secret = null;
  }

  function markupStatus(app: DeveloperApp): string {
    const requested = markupPercent(app.markup_bps ?? 0, locale);
    const effective = markupPercent(app.effective_markup_bps, locale);
    switch (app.markup_approval) {
      case "none":
        return $t("oauth.developerApps.markupNone", "No markup");
      case "approved":
        return $t(
          "oauth.developerApps.markupApproved",
          "{percent}% (approved)",
          {
            percent: requested,
          },
        );
      default:
        return $t(
          "oauth.developerApps.markupPending",
          "{requested}% requested, pending approval. {effective}% applies now.",
          { requested, effective },
        );
    }
  }

  // A reactive declaration, not a plain function: the template calls
  // `fieldError("name")`, and in this (non-runes) component a call to a
  // plain function is not re-evaluated when `serverErrors` changes, so
  // every server refusal outside `redirect_uris` rendered nothing.
  $: fieldError = (key: string): string => (serverErrors[key] ?? []).join(" ");

  onMount(() => {
    void load();
  });
</script>

<svelte:head>
  <title
    >{$t(
      "oauth.developerApps.metaTitle",
      "Your apps · Free2Z developers",
    )}</title
  >
</svelte:head>

<main class="mx-auto w-full max-w-3xl px-4 py-8">
  <header class="mb-6 flex flex-wrap items-start justify-between gap-3">
    <div class="space-y-1">
      <h1 class="text-2xl font-semibold">
        {$t("oauth.developerApps.title", "Your apps")}
      </h1>
      <p class="max-w-prose text-muted-foreground">
        {$t(
          "oauth.developerApps.intro",
          "Register apps that sign people in with Free2Z and use their 2Z usage credits for AI.",
        )}
      </p>
      <EconomyPolicyNote />
    </div>
    {#if !formOpen}
      <Button onclick={openCreate} data-testid="dev-app-new">
        {$t("oauth.developerApps.new", "Register an app")}
      </Button>
    {/if}
  </header>

  {#if notice}
    <p
      class="mb-4 rounded-md border bg-muted/40 p-3 text-sm"
      role="status"
      data-testid="dev-apps-notice"
    >
      {notice}
    </p>
  {/if}

  {#if formOpen}
    <form
      class="mb-8 space-y-5 rounded-lg border bg-card p-4 sm:p-6"
      on:submit|preventDefault={save}
      novalidate
      data-testid="dev-app-form"
    >
      <h2 class="text-lg font-semibold">
        {editing
          ? $t("oauth.developerApps.editTitle", "Edit {app}", {
              app: editing.name,
            })
          : $t("oauth.developerApps.newTitle", "Register an app")}
      </h2>

      <div class="space-y-1">
        <label for="dev-app-name" class="text-sm font-medium">
          {$t("oauth.developerApps.fields.name", "App name")}
        </label>
        <input
          id="dev-app-name"
          class="h-9 w-full rounded-md border bg-background px-3 text-sm"
          bind:value={form.name}
          maxlength="255"
          aria-invalid={formProblems.includes("name") ||
            Boolean(fieldError("name"))}
          aria-describedby="dev-app-name-help"
          data-testid="dev-app-name"
        />
        <p id="dev-app-name-help" class="text-xs text-muted-foreground">
          {$t(
            "oauth.developerApps.fields.nameHelp",
            "Shown to people on the consent screen.",
          )}
          {$t(
            "oauth.developerApps.fields.nameRule",
            "It cannot include “Free2Z” or anything that looks like it, or invisible characters.",
          )}
        </p>
        {#if formProblems.includes("name")}
          <p class="text-sm text-destructive">
            {$t("oauth.developerApps.errors.name", "Enter a name.")}
          </p>
        {/if}
        {#if fieldError("name")}
          <p class="text-sm text-destructive">{fieldError("name")}</p>
        {/if}
      </div>

      <fieldset class="space-y-2">
        <legend class="text-sm font-medium">
          {$t("oauth.developerApps.fields.clientType", "App type")}
        </legend>
        {#if editing}
          <p class="text-sm text-muted-foreground">
            {form.clientType === "confidential"
              ? $t(
                  "oauth.developerApps.types.confidential",
                  "Server-side (confidential)",
                )
              : $t(
                  "oauth.developerApps.types.public",
                  "Native, mobile or browser app (public)",
                )}
            — {$t(
              "oauth.developerApps.fields.clientTypeFixed",
              "The type cannot change after registration.",
            )}
          </p>
        {:else}
          <label class="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="radio"
              name="client-type"
              value="public"
              bind:group={form.clientType}
              class="mt-1"
              data-testid="dev-app-type-public"
            />
            <span>
              <span class="font-medium">
                {$t(
                  "oauth.developerApps.types.public",
                  "Native, mobile or browser app (public)",
                )}
              </span>
              <span class="block text-muted-foreground">
                {$t(
                  "oauth.developerApps.types.publicHelp",
                  "No secret is issued. Sign-in uses PKCE.",
                )}
              </span>
            </span>
          </label>
          <label class="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="radio"
              name="client-type"
              value="confidential"
              bind:group={form.clientType}
              class="mt-1"
              data-testid="dev-app-type-confidential"
            />
            <span>
              <span class="font-medium">
                {$t(
                  "oauth.developerApps.types.confidential",
                  "Server-side (confidential)",
                )}
              </span>
              <span class="block text-muted-foreground">
                {$t(
                  "oauth.developerApps.types.confidentialHelp",
                  "A client secret is issued once. Your server keeps it; https redirects only.",
                )}
              </span>
            </span>
          </label>
        {/if}
      </fieldset>

      <div class="space-y-1">
        <label for="dev-app-redirects" class="text-sm font-medium">
          {$t("oauth.developerApps.fields.redirectUris", "Redirect URIs")}
        </label>
        <textarea
          id="dev-app-redirects"
          class="min-h-24 w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
          bind:value={form.redirectUris}
          rows="3"
          spellcheck="false"
          autocapitalize="off"
          aria-invalid={uriProblems.length > 0 ||
            Boolean(fieldError("redirect_uris"))}
          aria-describedby="dev-app-redirects-help dev-app-redirects-errors"
          data-testid="dev-app-redirects"></textarea>
        <p id="dev-app-redirects-help" class="text-xs text-muted-foreground">
          {$t(
            "oauth.developerApps.fields.redirectUrisHelp",
            "One per line, matched exactly. https://…, http://127.0.0.1:<port>/… for desktop apps (any port matches), or an app scheme such as com.example.app:/oauth/callback.",
          )}
        </p>
        <ul
          id="dev-app-redirects-errors"
          class="space-y-1 text-sm"
          aria-live="polite"
          data-testid="dev-app-redirect-feedback"
        >
          {#each uriLines as line, index (index)}
            {#if !line.verdict.ok}
              <li
                class="text-destructive"
                data-testid="dev-app-redirect-problem"
              >
                <span class="font-mono break-all">{line.uri}</span>:
                {redirectProblemLabel($t, line.verdict.problem)}
              </li>
            {/if}
          {/each}
          {#each serverErrors.redirect_uris ?? [] as message}
            <li class="text-destructive">{message}</li>
          {/each}
        </ul>
      </div>

      <fieldset class="space-y-2">
        <legend class="text-sm font-medium">
          {$t(
            "oauth.developerApps.fields.scopes",
            "Scopes the app may request",
          )}
        </legend>
        <div class="grid gap-2 sm:grid-cols-2">
          {#each ALL_SCOPES as scope (scope)}
            <label class="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.allowedScopes.includes(scope)}
                on:change={(e) => toggleScope(scope, e.currentTarget.checked)}
                class="mt-1"
                data-scope={scope}
              />
              <span>
                <code class="text-xs">{scope}</code>
                <span class="block text-muted-foreground"
                  >{scopeLabel($t, scope)}</span
                >
              </span>
            </label>
          {/each}
        </div>
        {#if fieldError("allowed_scopes")}
          <p class="text-sm text-destructive">{fieldError("allowed_scopes")}</p>
        {/if}
      </fieldset>

      {#if form.clientType === "public"}
        <div class="space-y-1">
          <label for="dev-app-origins" class="text-sm font-medium">
            {$t(
              "oauth.developerApps.fields.origins",
              "Allowed web origins (browser apps)",
            )}
          </label>
          <textarea
            id="dev-app-origins"
            class="min-h-16 w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
            bind:value={form.allowedOrigins}
            rows="2"
            spellcheck="false"
            autocapitalize="off"
            aria-invalid={originLines.some((line) => !line.verdict.ok) ||
              Boolean(fieldError("allowed_origins"))}
            data-testid="dev-app-origins"></textarea>
          <p class="text-xs text-muted-foreground">
            {$t(
              "oauth.developerApps.fields.originsHelp",
              "Only for apps running in a web page: one https origin per line, with no path, query or fragment (https://app.example.com). Free2Z's own domains are not allowed.",
            )}
          </p>
          <ul class="space-y-1 text-sm" aria-live="polite">
            {#each originLines as line, index (index)}
              {#if !line.verdict.ok}
                <li
                  class="text-destructive"
                  data-testid="dev-app-origin-problem"
                >
                  <span class="font-mono break-all">{line.origin}</span>:
                  {originProblemLabel($t, line.verdict)}
                </li>
              {/if}
            {/each}
          </ul>
          {#if fieldError("allowed_origins")}
            <p class="text-sm text-destructive">
              {fieldError("allowed_origins")}
            </p>
          {/if}
        </div>
      {/if}

      <div class="space-y-1">
        <label for="dev-app-markup" class="text-sm font-medium">
          {$t("oauth.developerApps.fields.markup", "Markup on AI cost (%)")}
        </label>
        <input
          id="dev-app-markup"
          class="h-9 w-32 rounded-md border bg-background px-3 text-sm"
          bind:value={form.markupPercent}
          inputmode="decimal"
          aria-invalid={formProblems.includes("markup") ||
            Boolean(fieldError("markup_bps"))}
          aria-describedby="dev-app-markup-help"
          data-testid="dev-app-markup"
        />
        <p id="dev-app-markup-help" class="text-xs text-muted-foreground">
          {$t(
            "oauth.developerApps.fields.markupHelp",
            "What you ask to add on top of each AI request's cost, up to {cap}%. It applies only after Free2Z approves it; until then the request is pending. People see the markup before they connect.",
            { cap: markupCapPercent },
          )}
        </p>
        {#if formProblems.includes("markup")}
          <p class="text-sm text-destructive">
            {$t(
              "oauth.developerApps.errors.markup",
              "Enter a percentage from 0 to {cap}, with at most two decimals.",
              { cap: markupCapPercent },
            )}
          </p>
        {/if}
        {#if fieldError("markup_bps")}
          <p class="text-sm text-destructive">{fieldError("markup_bps")}</p>
        {/if}
      </div>

      <div class="space-y-1">
        <span class="text-sm font-medium" id="dev-app-cap-label">
          {$t(
            "oauth.developerApps.fields.defaultCap",
            "Suggested budget per user",
          )}
        </span>
        <div class="flex flex-wrap items-center gap-2">
          <input
            class="h-9 w-32 rounded-md border bg-background px-3 text-sm"
            bind:value={form.defaultCap}
            inputmode="numeric"
            aria-labelledby="dev-app-cap-label"
            aria-invalid={formProblems.includes("defaultCap") ||
              Boolean(fieldError("default_spend_cap_2z"))}
          />
          <span class="text-sm">2Z</span>
          <select
            class="h-9 rounded-md border bg-background px-2 text-sm"
            bind:value={form.defaultCapPeriod}
            aria-label={$t("oauth.consent.cap.periodLabel", "Period")}
          >
            {#each CAP_PERIODS as period (period)}
              <option value={period}>{capPeriodLabel($t, period)}</option>
            {/each}
          </select>
        </div>
        <p class="text-xs text-muted-foreground">
          {$t(
            "oauth.developerApps.fields.defaultCapHelp",
            "Optional suggestion for each user when they authorize AI spending, not a shared app quota. Users can change it or use their available prepaid balance without an extra budget. Leave empty to suggest no extra budget.",
          )}
        </p>
        {#if formProblems.includes("defaultCap")}
          <p class="text-sm text-destructive">
            {$t(
              "oauth.developerApps.errors.defaultCap",
              "Enter a whole number of 2Z credits, or leave it empty.",
            )}
          </p>
        {/if}
      </div>

      <div class="grid gap-3 sm:grid-cols-3">
        <div class="space-y-1">
          <label for="dev-app-logo" class="text-sm font-medium">
            {$t("oauth.developerApps.fields.logo", "Logo URL")}
          </label>
          <input
            id="dev-app-logo"
            type="url"
            class="h-9 w-full rounded-md border bg-background px-3 text-sm"
            bind:value={form.logoUrl}
            aria-invalid={formProblems.includes("logoUrl") ||
              Boolean(fieldError("logo_url"))}
            data-testid="dev-app-logo"
          />
          {#if formProblems.includes("logoUrl")}
            <p class="text-sm text-destructive">
              {$t(
                "oauth.developerApps.errors.httpsUrl",
                "Use an https:// address.",
              )}
            </p>
          {/if}
          {#if fieldError("logo_url")}
            <p class="text-sm text-destructive">{fieldError("logo_url")}</p>
          {/if}
        </div>
        <div class="space-y-1">
          <label for="dev-app-privacy" class="text-sm font-medium">
            {$t("oauth.developerApps.fields.privacy", "Privacy policy URL")}
          </label>
          <input
            id="dev-app-privacy"
            type="url"
            class="h-9 w-full rounded-md border bg-background px-3 text-sm"
            bind:value={form.privacyUrl}
            aria-invalid={formProblems.includes("privacyUrl") ||
              Boolean(fieldError("privacy_url"))}
            data-testid="dev-app-privacy"
          />
          {#if formProblems.includes("privacyUrl")}
            <p class="text-sm text-destructive">
              {$t(
                "oauth.developerApps.errors.httpsUrl",
                "Use an https:// address.",
              )}
            </p>
          {/if}
          {#if fieldError("privacy_url")}
            <p class="text-sm text-destructive">{fieldError("privacy_url")}</p>
          {/if}
        </div>
        <div class="space-y-1">
          <label for="dev-app-terms" class="text-sm font-medium">
            {$t("oauth.developerApps.fields.terms", "Terms URL")}
          </label>
          <input
            id="dev-app-terms"
            type="url"
            class="h-9 w-full rounded-md border bg-background px-3 text-sm"
            bind:value={form.termsUrl}
            aria-invalid={formProblems.includes("termsUrl") ||
              Boolean(fieldError("terms_url"))}
            data-testid="dev-app-terms"
          />
          {#if formProblems.includes("termsUrl")}
            <p class="text-sm text-destructive">
              {$t(
                "oauth.developerApps.errors.httpsUrl",
                "Use an https:// address.",
              )}
            </p>
          {/if}
          {#if fieldError("terms_url")}
            <p class="text-sm text-destructive">{fieldError("terms_url")}</p>
          {/if}
        </div>
      </div>

      <label class="flex cursor-pointer items-start gap-2 text-sm">
        <input
          type="checkbox"
          bind:checked={form.childDirected}
          disabled={Boolean(editing?.child_directed)}
          class="mt-1"
          data-testid="dev-app-child-directed"
        />
        <span>
          {$t(
            "oauth.developerApps.fields.childDirected",
            "Children may use this app",
          )}
          <span class="block text-muted-foreground">
            {$t(
              "oauth.developerApps.fields.childDirectedHelp",
              "The consent screen speaks to the adult account holder. Only Free2Z staff can turn this off.",
            )}
          </span>
        </span>
      </label>
      {#if fieldError("child_directed")}
        <p class="text-sm text-destructive">{fieldError("child_directed")}</p>
      {/if}

      {#if fieldError("non_field_errors") || fieldError("client_type")}
        <p class="text-sm text-destructive">
          {fieldError("non_field_errors")}
          {fieldError("client_type")}
        </p>
      {/if}
      {#if saveError}
        <p
          class="text-sm text-destructive"
          role="alert"
          data-testid="dev-app-save-error"
        >
          {saveError}
        </p>
      {/if}

      <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onclick={closeForm} disabled={saving}>
          {$t("oauth.common.cancel", "Cancel")}
        </Button>
        <Button type="submit" disabled={saving} data-testid="dev-app-save">
          {editing
            ? $t("oauth.developerApps.save", "Save changes")
            : $t("oauth.developerApps.register", "Register app")}
        </Button>
      </div>
    </form>
  {/if}

  {#if status === "loading"}
    <p class="text-muted-foreground" role="status">
      {$t("oauth.developerApps.loading", "Loading your apps…")}
    </p>
  {:else if status === "error"}
    <div class="space-y-3" role="alert">
      <p class="text-muted-foreground">
        {$t("oauth.developerApps.loadFailed", "Your apps could not be loaded.")}
      </p>
      <Button onclick={load}>{$t("oauth.consent.tryAgain", "Try again")}</Button
      >
    </div>
  {:else if apps.length === 0}
    <p class="text-muted-foreground" data-testid="dev-apps-empty">
      {$t("oauth.developerApps.empty", "You have not registered any apps yet.")}
    </p>
  {:else}
    <ul class="space-y-4" data-testid="dev-apps-list">
      {#each apps as app (app.id)}
        <li
          class="space-y-3 rounded-lg border bg-card p-4"
          data-testid="dev-app"
          data-app-id={app.id}
        >
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <h2 class="font-semibold break-words">{app.name}</h2>
              <p class="text-sm text-muted-foreground">
                {app.client_type === "confidential"
                  ? $t(
                      "oauth.developerApps.types.confidential",
                      "Server-side (confidential)",
                    )
                  : $t(
                      "oauth.developerApps.types.public",
                      "Native, mobile or browser app (public)",
                    )}
                {#if app.frozen}
                  · <span class="text-destructive"
                    >{$t(
                      "oauth.developerApps.frozen",
                      "Frozen by Free2Z",
                    )}</span
                  >
                {/if}
              </p>
            </div>
            <div class="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onclick={() => openEdit(app)}
                data-testid="dev-app-edit"
              >
                {$t("oauth.developerApps.edit", "Edit")}
              </Button>
              {#if app.client_type === "confidential"}
                <Button
                  variant="outline"
                  size="sm"
                  onclick={() => askRotate(app)}
                  data-testid="dev-app-rotate"
                >
                  {$t("oauth.developerApps.rotate", "New secret")}
                </Button>
              {/if}
              <Button
                variant="outline"
                size="sm"
                onclick={() => askDelete(app)}
                data-testid="dev-app-delete"
              >
                {$t("oauth.developerApps.delete", "Delete")}
              </Button>
            </div>
          </div>

          <dl class="grid gap-3 text-sm sm:grid-cols-2">
            <div class="min-w-0">
              <dt class="text-muted-foreground">
                {$t("oauth.developerApps.clientId", "Client ID")}
              </dt>
              <dd
                class="font-mono text-xs break-all"
                data-testid="dev-app-client-id"
              >
                {app.client_id}
              </dd>
            </div>
            <div>
              <dt class="text-muted-foreground">
                {$t("oauth.developerApps.markup", "Markup")}
              </dt>
              <dd
                data-testid="dev-app-markup-status"
                data-approval={app.markup_approval}
              >
                {markupStatus(app)}
              </dd>
            </div>
            <div class="min-w-0 sm:col-span-2">
              <dt class="text-muted-foreground">
                {$t("oauth.developerApps.fields.redirectUris", "Redirect URIs")}
              </dt>
              <dd>
                <ul class="font-mono text-xs">
                  {#each app.redirect_uris as uri (uri)}
                    <li class="break-all">{uri}</li>
                  {/each}
                </ul>
              </dd>
            </div>
            {#if (app.allowed_scopes ?? []).length}
              <div class="min-w-0 sm:col-span-2">
                <dt class="text-muted-foreground">
                  {$t(
                    "oauth.developerApps.fields.scopes",
                    "Scopes the app may request",
                  )}
                </dt>
                <dd class="font-mono text-xs break-words">
                  {(app.allowed_scopes ?? []).join(" ")}
                </dd>
              </div>
            {/if}
          </dl>
        </li>
      {/each}
    </ul>
  {/if}
</main>

<Dialog.Root
  bind:open={secretOpen}
  onOpenChange={(open) => {
    if (!open) closeSecret();
  }}
>
  <Dialog.Content data-testid="dev-app-secret-dialog">
    <Dialog.Header>
      <Dialog.Title
        >{$t(
          "oauth.developerApps.secretTitle",
          "Your client secret",
        )}</Dialog.Title
      >
      <Dialog.Description>
        {$t(
          "oauth.developerApps.secretBody",
          "Copy the secret for {app} now and store it on your server. It will not be shown again. If you lose it, issue a new one.",
          { app: secret?.appName ?? "" },
        )}
      </Dialog.Description>
    </Dialog.Header>
    {#if secret}
      <code
        class="block rounded-md border bg-muted/40 p-3 font-mono text-sm break-all select-all"
        data-testid="dev-app-secret">{secret.value}</code
      >
    {/if}
    <Dialog.Footer class="gap-2">
      <Button
        variant="outline"
        onclick={copySecret}
        data-testid="dev-app-secret-copy"
      >
        {copied
          ? $t("oauth.developerApps.copied", "Copied")
          : $t("oauth.developerApps.copy", "Copy")}
      </Button>
      <Button onclick={closeSecret} data-testid="dev-app-secret-done">
        {$t("oauth.developerApps.secretDone", "I have stored it")}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={deleteOpen}>
  <Dialog.Content data-testid="dev-app-delete-dialog">
    <Dialog.Header>
      <Dialog.Title>
        {$t("oauth.developerApps.deleteTitle", "Delete {app}?", {
          app: deleteTarget?.name ?? "",
        })}
      </Dialog.Title>
      <Dialog.Description>
        {$t(
          "oauth.developerApps.deleteBody",
          "Its client ID stops working. An app that people have already connected cannot be deleted.",
        )}
      </Dialog.Description>
    </Dialog.Header>
    {#if deleteError}
      <p
        class="text-sm text-destructive"
        role="alert"
        data-testid="dev-app-delete-error"
      >
        {deleteError}
      </p>
    {/if}
    <Dialog.Footer class="gap-2">
      <Button
        variant="outline"
        onclick={() => (deleteOpen = false)}
        disabled={deleting}
      >
        {$t("oauth.common.cancel", "Cancel")}
      </Button>
      <Button
        variant="destructive"
        onclick={confirmDelete}
        disabled={deleting}
        data-testid="dev-app-delete-confirm"
      >
        {$t("oauth.developerApps.delete", "Delete")}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={rotateOpen}>
  <Dialog.Content data-testid="dev-app-rotate-dialog">
    <Dialog.Header>
      <Dialog.Title>
        {$t(
          "oauth.developerApps.rotateTitle",
          "Issue a new secret for {app}?",
          {
            app: rotateTarget?.name ?? "",
          },
        )}
      </Dialog.Title>
      <Dialog.Description>
        {$t(
          "oauth.developerApps.rotateBody",
          "The current secret stops working immediately. Update your server with the new one right away.",
        )}
      </Dialog.Description>
    </Dialog.Header>
    {#if rotateError}
      <p class="text-sm text-destructive" role="alert">{rotateError}</p>
    {/if}
    <Dialog.Footer class="gap-2">
      <Button
        variant="outline"
        onclick={() => (rotateOpen = false)}
        disabled={rotating}
      >
        {$t("oauth.common.cancel", "Cancel")}
      </Button>
      <Button
        variant="destructive"
        onclick={confirmRotate}
        disabled={rotating}
        data-testid="dev-app-rotate-confirm"
      >
        {$t("oauth.developerApps.rotate", "New secret")}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
