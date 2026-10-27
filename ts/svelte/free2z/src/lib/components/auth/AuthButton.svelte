<script lang="ts">
  import { tStore as t } from "$lib/i18n";
  import Button from "$lib/components/ui/button/button.svelte";
  import { requestLogin } from "$lib/stores/auth-modal";

  // The navbar's Sign In is just another caller of the shared modal:
  // the password → OTP handoff lives in AuthModalHost, mounted once from the
  // root layout, so this component no longer keeps a private copy of it.
  function openLogin(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    requestLogin({ trigger: e.currentTarget as HTMLElement });
  }
</script>

<!-- Not authenticated: Show login button -->
<Button
  onclick={openLogin}
  variant="default"
  size="sm"
  type="button"
  class="px-3"
  data-testid="navbar-auth-trigger"
  aria-label={$t("common.auth.signIn", "Sign In")}
>
  {$t("common.auth.signIn", "Sign In")}
</Button>
