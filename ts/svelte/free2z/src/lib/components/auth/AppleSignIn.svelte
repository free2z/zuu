<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from "svelte";
  import { get } from "svelte/store";
  import { apiFetch } from "$lib/api/config";
  import { authStore, currentUser } from "$lib/stores/auth";
  import { tStore as t } from "$lib/i18n";
  import { Button } from "$lib/components/ui/button";

  export let associate = false;
  const dispatch = createEventDispatcher<{ success: { creator: any } }>();
  let linked: { provider_uid: string; needs_reconnect?: boolean }[] = [];
  let available = false;
  let busy = false;
  let error = "";
  let stopped = false;
  let popup: Window | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let nonce = "";
  let owner: string | null = null;

  function cleanup() {
    clearInterval(timer);
    popup?.close();
    popup = null;
    nonce = "";
    busy = false;
  }
  async function loadLinked() {
    if (!associate) return;
    const response = await apiFetch("/api/auth/social/");
    if (response.ok) {
      const rows = await response.json();
      if (!stopped && Array.isArray(rows))
        linked = rows.filter((row) => row.provider === "apple");
    }
  }
  async function unlink(uid: string) {
    busy = true;
    error = "";
    try {
      const response = await apiFetch("/api/auth/social/apple/unlink/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider_uid: uid }),
      });
      if (!response.ok) {
        error =
          response.status === 409
            ? $t(
                "auth.appleLastMethod",
                "Set a password or reconnect another login method before removing Apple.",
              )
            : $t(
                "auth.appleUnlinkFailed",
                "Apple could not be removed. Try again.",
              );
        return;
      }
      linked = linked.filter((row) => row.provider_uid !== uid);
      await authStore.checkAuth({ force: true });
    } catch {
      error = $t(
        "auth.appleUnlinkFailed",
        "Apple could not be removed. Try again.",
      );
    } finally {
      busy = false;
    }
  }
  onMount(() => {
    void loadLinked().catch(() => {});
    apiFetch("/api/auth/social/providers/")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        available =
          !stopped &&
          data?.providers?.some(
            (entry: any) =>
              entry.provider === "apple" &&
              entry.configured === true &&
              entry.web_only === true,
          ) === true;
      })
      .catch(() => {
        available = false;
      });
    window.addEventListener("message", receive);
  });
  onDestroy(() => {
    stopped = true;
    if (typeof window !== "undefined")
      window.removeEventListener("message", receive);
    cleanup();
  });

  async function receive(event: MessageEvent) {
    if (
      event.origin !== window.location.origin ||
      event.source !== popup ||
      event.data?.type !== "free2z-reauth" ||
      event.data?.nonce !== nonce ||
      !nonce ||
      event.data?.ok !== true
    )
      return;
    nonce = "";
    try {
      await authStore.checkAuth({ force: true });
      const creator = get(currentUser);
      if (!creator || (associate && creator.username !== owner))
        throw new Error();
      await loadLinked();
      cleanup();
      if (!stopped) dispatch("success", { creator });
    } catch {
      error = $t("auth.appleFailed", "Apple sign-in failed. Start again.");
      cleanup();
    }
  }

  async function start() {
    if (busy) return;
    owner = get(currentUser)?.username ?? null;
    if (associate !== (owner !== null)) return;
    error = "";
    busy = true;
    popup = window.open("about:blank", "_blank", "popup,width=600,height=750");
    if (!popup) {
      error = $t("auth.applePopup", "Allow popups to continue with Apple.");
      cleanup();
      return;
    }
    const opened = popup;
    const started = Date.now();
    nonce = crypto.randomUUID();
    try {
      const redirect = `${window.location.origin}/oauth/reauth-callback`;
      const response = await apiFetch(
        `/api/auth/social/apple/start?redirect_uri=${encodeURIComponent(redirect)}`,
      );
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (stopped || popup !== opened) return;
      const url = new URL(data.authorize_url);
      if (
        url.origin !== "https://appleid.apple.com" ||
        url.pathname !== "/auth/authorize" ||
        url.searchParams.get("redirect_uri") !== redirect ||
        url.searchParams.get("state") !== data.state ||
        url.searchParams.get("response_mode") !== "fragment"
      )
        throw new Error();
      opened.sessionStorage.setItem(
        "free2z-reauth",
        JSON.stringify({
          provider: "apple",
          state: data.state,
          redirect,
          nonce,
          expires: Date.now() + 300000,
        }),
      );
      opened.location.href = url.toString();
      timer = setInterval(() => {
        if (opened.closed || Date.now() - started > 300000) {
          error = $t(
            "auth.appleCancelled",
            "Apple sign-in cancelled or expired. Start again.",
          );
          cleanup();
        }
      }, 300);
    } catch {
      error = $t("auth.appleFailed", "Apple sign-in failed. Start again.");
      cleanup();
    }
  }
</script>

{#if available}
  <Button
    type="button"
    variant="outline"
    class="w-full"
    disabled={busy}
    onclick={start}
  >
    {associate
      ? $t("auth.linkApple", "Link Apple")
      : $t("auth.continueApple", "Continue with Apple")}
  </Button>
{/if}
{#if error}<p role="alert">{error}</p>{/if}

{#if associate}
  {#each linked as identity}
    <p>{$t("auth.appleLinked", "Apple is linked to this account.")}</p>
    <Button
      type="button"
      variant="outline"
      disabled={busy}
      onclick={() => unlink(identity.provider_uid)}
    >
      {$t("auth.unlinkApple", "Unlink Apple")}
    </Button>
  {/each}
{/if}
