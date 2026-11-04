<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from "svelte";
  import { get } from "svelte/store";
  import { apiFetch } from "$lib/api/config";
  import { authStore, currentUser } from "$lib/stores/auth";
  import { fetchTwitterAuthorizeUrl } from "$lib/twitter-authorize";
  import { Button } from "$lib/components/ui/button";

  const dispatch = createEventDispatcher<{ success: { creator: any } }>();
  const labels: Record<string, string> = {
    google: "Google",
    github: "GitHub",
    x: "X",
  };
  let providers: string[] = [];
  let error = "";
  let busy = false;
  let address = "";
  let challenge = "";
  let signature = "";
  let otp = "";
  let popup: Window | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let nonce = "";
  let stopped = false;

  async function json(path: string, body?: object) {
    const response = await apiFetch(
      path,
      body
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : undefined,
    );
    const value = await response.json();
    if (!response.ok)
      throw new Error(
        value.detail ||
          "Sign-in failed. Start again with an existing sign-in method.",
      );
    return value;
  }

  function cleanup() {
    clearInterval(timer);
    timer = undefined;
    popup?.close();
    popup = null;
    nonce = "";
    busy = false;
  }

  async function complete() {
    // A popup message is only a notification. Check the actual browser
    // credential before accepting it, and re-read the account for draft safety.
    const proof = await json("/api/auth/recent/");
    await authStore.checkAuth({ force: true });
    const creator = get(currentUser);
    if (!creator || creator.username !== proof.username)
      throw new Error("Your account changed. Close this dialog and try again.");
    if (stopped) return;
    cleanup();
    dispatch("success", { creator });
  }

  async function receive(event: MessageEvent) {
    if (
      event.origin !== window.location.origin ||
      event.source !== popup ||
      event.data?.type !== "free2z-reauth" ||
      event.data?.nonce !== nonce
    )
      return;
    // Consume before waiting, so a duplicate notification cannot complete twice.
    nonce = "";
    try {
      if (!event.data.ok)
        throw new Error(
          "Provider sign-in failed. Start again with your existing account.",
        );
      await complete();
    } catch (cause) {
      error = String(cause instanceof Error ? cause.message : cause);
      cleanup();
    }
  }

  onMount(() => {
    window.addEventListener("message", receive);
    Promise.all([
      json("/api/auth/social/"),
      json("/api/auth/social/providers/"),
    ])
      .then(([rows, availability]) => {
        const enabled = new Set(
          availability.providers
            .filter(
              (entry: any) => entry.configured && entry.web_reauthentication,
            )
            .map((entry: any) => entry.provider),
        );
        if (!stopped && Array.isArray(rows))
          providers = [
            ...new Set<string>(
              rows
                .filter(
                  (row) =>
                    !row.needs_reconnect &&
                    labels[row.provider] &&
                    enabled.has(row.provider),
                )
                .map((row) => row.provider),
            ),
          ];
      })
      .catch(() => {
        /* Password, legacy X and wallet remain available. */
      });
  });
  onDestroy(() => {
    stopped = true;
    if (typeof window !== "undefined")
      window.removeEventListener("message", receive);
    cleanup();
  });

  async function providerLogin(provider: string) {
    error = "";
    busy = true;
    // Open on the click stack, before the async start call (popup blockers).
    popup = window.open("about:blank", "_blank", "popup,width=600,height=750");
    if (!popup) {
      error = "Allow popups to sign in without leaving your pending changes.";
      busy = false;
      return;
    }
    const started = Date.now();
    const opened = popup;
    nonce = crypto.randomUUID();
    try {
      if (provider === "legacy-x") {
        const target = await fetchTwitterAuthorizeUrl(apiFetch);
        if (stopped || popup !== opened) return;
        opened.location.href = target;
      } else {
        const redirect = `${window.location.origin}/oauth/reauth-callback`;
        const start = await json(
          `/api/auth/social/${provider}/start?redirect_uri=${encodeURIComponent(redirect)}`,
        );
        if (stopped || popup !== opened) return;
        opened.sessionStorage.setItem(
          "free2z-reauth",
          JSON.stringify({
            provider,
            state: start.state,
            redirect,
            nonce,
            expires: Date.now() + 300000,
          }),
        );
        opened.location.href = start.authorize_url;
      }
      timer = setInterval(() => {
        if (opened.closed || Date.now() - started > 300000) {
          error =
            "Sign-in cancelled or expired. Your pending changes are still here.";
          cleanup();
          return;
        }
        if (provider === "legacy-x") {
          try {
            // Legacy X returns to /profile (then the dashboard). Its final
            // URL alone is not proof; the server freshness check is mandatory.
            if (
              opened.location.origin === window.location.origin &&
              (opened.location.pathname === "/profile" ||
                opened.location.pathname.includes("/dashboard"))
            ) {
              clearInterval(timer);
              complete().catch((cause) => {
                error = cause.message;
                cleanup();
              });
            }
          } catch {
            /* The provider is cross-origin until its callback. */
          }
        }
      }, 300);
    } catch (cause) {
      error = String(cause instanceof Error ? cause.message : cause);
      cleanup();
    }
  }

  async function walletChallenge() {
    error = "";
    busy = true;
    signature = "";
    try {
      challenge = (await json("/api/auth/zcash/challenge/", { address }))
        .challenge;
    } catch (cause) {
      error = String(cause instanceof Error ? cause.message : cause);
    } finally {
      busy = false;
    }
  }
  async function walletLogin() {
    error = "";
    busy = true;
    try {
      // The returned native bearer token is deliberately discarded. This
      // browser uses the freshly rotated existing session cookie exclusively.
      await json("/api/auth/zcash/login/", {
        address,
        challenge,
        signature,
        otp_token: otp,
      });
      await complete();
    } catch (cause) {
      error = String(cause instanceof Error ? cause.message : cause);
      challenge = "";
      signature = "";
    } finally {
      busy = false;
    }
  }
</script>

<div class="mb-4 space-y-3 rounded-md border p-3">
  <p>Use a sign-in method already linked to this Free2Z account.</p>
  {#each providers as provider}
    <Button
      variant="outline"
      disabled={busy}
      onclick={() => providerLogin(provider)}
      >Continue with {labels[provider]}</Button
    >
  {/each}
  <Button
    variant="outline"
    disabled={busy}
    onclick={() => providerLogin("legacy-x")}
    >Continue with linked X account</Button
  >
  <details>
    <summary>Sign in with an existing Zcash wallet</summary>
    <p class="my-2 text-sm">
      Prove your existing wallet to Free2Z before changing this account’s
      sign-in methods. Sign the exact challenge below with your wallet. Never
      enter your private key or seed phrase.
    </p>
    <label class="block"
      >Zcash address
      <input
        class="block w-full rounded border p-2"
        bind:value={address}
        disabled={busy || !!challenge}
      />
    </label>
    <label class="block"
      >Wallet two-factor code (if enabled)
      <input
        class="block w-full rounded border p-2"
        aria-label="Wallet two-factor code"
        bind:value={otp}
        autocomplete="one-time-code"
        inputmode="numeric"
        disabled={busy}
      />
    </label>
    {#if challenge}
      <label class="block"
        >Free2Z sign-in challenge<textarea
          class="block w-full rounded border p-2"
          readonly
          value={challenge}></textarea></label
      >
      <label class="block"
        >Wallet signature<textarea
          class="block w-full rounded border p-2"
          bind:value={signature}
          disabled={busy}></textarea></label
      >
      <Button disabled={busy || !signature} onclick={walletLogin}
        >Verify wallet signature</Button
      >
      <Button
        variant="outline"
        disabled={busy}
        onclick={() => {
          challenge = "";
          signature = "";
        }}>New challenge</Button
      >
    {:else}
      <Button disabled={busy || !address} onclick={walletChallenge}
        >Get sign-in challenge</Button
      >
    {/if}
  </details>
  {#if error}<p role="alert" class="text-red-600">{error}</p>{/if}
</div>
