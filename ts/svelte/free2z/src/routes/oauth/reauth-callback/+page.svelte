<script lang="ts">
  import { onMount } from "svelte";
  import { apiFetch } from "$lib/api/config";
  let status = "Completing sign-in…";
  let otp = "";
  let pending: {
    provider: string;
    state: string;
    redirect: string;
    nonce: string;
    expires: number;
  } | null = null;
  let code = "";
  let submitting = false;
  onMount(() => {
    const raw = sessionStorage.getItem("free2z-reauth");
    sessionStorage.removeItem("free2z-reauth");
    const params = new URLSearchParams(window.location.search);
    // Keep the one-time code in memory only, never in history or storage.
    history.replaceState(null, "", window.location.pathname);
    try {
      const attempt = JSON.parse(raw || "null");
      if (
        !attempt ||
        !window.opener ||
        attempt.expires < Date.now() ||
        !["google", "github", "twitter"].includes(attempt.provider) ||
        attempt.redirect !==
          `${window.location.origin}/oauth/reauth-callback` ||
        params.getAll("state").length !== 1 ||
        params.get("state") !== attempt.state ||
        params.getAll("code").length !== 1 ||
        !params.get("code") ||
        params.has("error")
      ) {
        throw new Error(
          "This sign-in attempt is invalid or expired. Start again from settings.",
        );
      }
      pending = attempt;
      code = params.get("code")!;
      status =
        "Provider sign-in complete. Enter your current two-factor code if enabled, then finish signing in.";
    } catch (error) {
      status = error instanceof Error ? error.message : "Sign-in failed.";
    }
  });

  async function finish() {
    if (!pending || submitting) return;
    const attempt = pending;
    // Consume locally before the request. A bad OTP also consumes the
    // provider code server-side, so retry means a NEW provider round trip.
    pending = null;
    submitting = true;
    status = "Checking your sign-in…";
    const proof = code;
    code = "";
    try {
      if (attempt.expires < Date.now())
        throw new Error(
          "This sign-in attempt expired. Close this window and start again from settings.",
        );
      const response = await apiFetch(`/api/auth/social/${attempt.provider}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: proof,
          state: attempt.state,
          redirect_uri: attempt.redirect,
          otp_token: otp,
        }),
      });
      otp = "";
      // Do not persist or relay the bearer token returned by this native API.
      if (!response.ok)
        throw new Error(
          "Sign-in failed. Close this window and start again from settings with the account already linked to Free2Z and a current two-factor code if enabled.",
        );
      window.opener?.postMessage(
        { type: "free2z-reauth", nonce: attempt.nonce, ok: true },
        window.location.origin,
      );
      status = "Signed in. Return to settings to save your pending changes.";
    } catch (error) {
      otp = "";
      status =
        error instanceof Error
          ? error.message
          : "Sign-in failed. Start again from settings.";
      // Leave the explicit restart explanation visible in this window. The
      // opener sees cancellation when the user closes it; no consumed proof
      // is made available for a second attempt.
    } finally {
      submitting = false;
    }
  }
</script>

<svelte:head
  ><meta name="referrer" content="no-referrer" /><title>Free2Z sign-in</title
  ></svelte:head
>
<div class="mx-auto max-w-lg space-y-4 p-8">
  <p data-testid="reauth-callback-status" role="status">{status}</p>
  {#if pending}
    <form on:submit|preventDefault={finish} class="space-y-4">
      <label class="block"
        >Current two-factor code (if enabled)
        <input
          class="block w-full rounded border p-2"
          bind:value={otp}
          autocomplete="one-time-code"
          inputmode="numeric"
        />
      </label>
      <button
        type="submit"
        class="rounded border px-4 py-2"
        disabled={submitting}>Finish signing in</button
      >
    </form>
  {/if}
</div>
