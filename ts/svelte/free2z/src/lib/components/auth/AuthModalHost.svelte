<script lang="ts">
  // The single mount point for the sign-in modal — see $lib/stores/auth-modal
  //. Rendered once from the root layout; every "Log in" control in
  // the app opens it through `requestLogin()` and stays exactly where it is.
  import { authModal, type AuthModalRequest } from "$lib/stores/auth-modal";
  import { currentUser, type Creator } from "$lib/stores/auth";
  import { tStore as t } from "$lib/i18n";
  import { toast } from "$lib/toast.js";
  import UnifiedAuthModal from "$lib/components/auth/UnifiedAuthModal.svelte";
  import OTPModal from "$lib/components/auth/OTPModal.svelte";

  let showAuthModal = false;
  let showOTPModal = false;
  let otpData = { username: "", password: "", captcha_result: "" };
  let initialView: "login" | "signup" = "login";
  let notice = "";

  let request: AuthModalRequest | null = null;
  let handledRequestId = 0;
  // Set the moment a login succeeds, so the `close` the modal dispatches on
  // its way out is not mistaken for a dismissal.
  let settled = false;

  $: if ($authModal.request && $authModal.request.id !== handledRequestId) {
    handledRequestId = $authModal.request.id;
    request = $authModal.request;
    initialView = request.view;
    notice = request.notice;
    settled = false;
    showOTPModal = false;
    showAuthModal = true;
  }

  // A route owner can cancel its own request when its component is destroyed.
  $: if (!$authModal.open) {
    showAuthModal = false;
    showOTPModal = false;
    request = null;
  }

  function welcome(creator: Creator | null) {
    const name = creator?.full_name || creator?.username;
    toast.success(
      name
        ? $t("auth.welcomeBackNamed", "Welcome back, {name}!", { name })
        : $t("auth.welcomeBack", "Welcome back!"),
    );
  }

  function ownsRequest(requestId: number) {
    return $authModal.open && $authModal.request?.id === requestId;
  }

  function finish(creator: Creator | null, requestId: number) {
    if (!ownsRequest(requestId)) return;
    settled = true;
    showAuthModal = false;
    showOTPModal = false;
    authModal.close();
    welcome(creator);
    request?.onSuccess?.(creator);
  }

  function handleAuthSuccess(
    event: CustomEvent<{ creator: Creator }>,
    requestId: number,
  ) {
    finish(event?.detail?.creator ?? $currentUser, requestId);
  }

  // The password step is done; the same username/password/captcha_result
  // are carried into the OTP step so MFA never re-enters the sign-up flow.
  function handleAuthRequiresOTP(
    event: CustomEvent<{
      username: string;
      password: string;
      captcha_result: string;
    }>,
    requestId: number,
  ) {
    if (!ownsRequest(requestId)) return;
    otpData = event.detail;
    showAuthModal = false;
    showOTPModal = true;
  }

  function handleOTPSuccess(requestId: number) {
    finish($currentUser, requestId);
  }

  function handleOTPBack(requestId: number) {
    if (!ownsRequest(requestId)) return;
    showOTPModal = false;
    showAuthModal = true;
  }

  function restoreFocus() {
    const trigger = request?.trigger;
    if (!trigger || !trigger.isConnected) return;
    // After the dialog's own teardown, which otherwise lands focus on <body>.
    requestAnimationFrame(() => {
      if (trigger.isConnected) trigger.focus();
    });
  }

  function dismissed() {
    if (settled) return;
    authModal.close();
    restoreFocus();
  }

  // `close` fires on every way out of the password step, including the
  // hand-off to OTP and the exit after a success; only a real dismissal
  // counts as one.
  function handleAuthClose(requestId: number) {
    if (!ownsRequest(requestId)) return;
    if (showOTPModal || settled) return;
    dismissed();
  }

  function handleOTPClose(requestId: number) {
    if (!ownsRequest(requestId)) return;
    // "Back" reopens the password step before the OTP dialog closes.
    if (showAuthModal || settled) return;
    dismissed();
  }

  // The backstop, and for the OTP step the ONLY thing that fires ( codex
  // review): OTPModal dispatches `close` from its own close()/goBack() alone —
  // Escape, a click outside and the dialog's own X just flip its bound `open`.
  // Without this, dismissing the OTP step left the store reading "open" with
  // no dialog on screen, and `/login` kept its own fallback ("Open login")
  // hidden behind `{#if !$authModal.open}` with nothing to click.
  $: if ($authModal.open && !showAuthModal && !showOTPModal && !settled) {
    dismissed();
  }
</script>

{#if request}
  {#key request.id}
    {@const requestId = request.id}
    <UnifiedAuthModal
      bind:open={showAuthModal}
      {initialView}
      {notice}
      reauthentication={request.reauthentication ?? false}
      on:success={(event) => handleAuthSuccess(event, requestId)}
      on:requiresOTP={(event) => handleAuthRequiresOTP(event, requestId)}
      on:close={() => handleAuthClose(requestId)}
    />
    <OTPModal
      bind:open={showOTPModal}
      username={otpData.username}
      password={otpData.password}
      captchaResult={otpData.captcha_result}
      on:success={() => handleOTPSuccess(requestId)}
      on:back={() => handleOTPBack(requestId)}
      on:close={() => handleOTPClose(requestId)}
    />
  {/key}
{/if}
