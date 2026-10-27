<script lang="ts">
  import { tStore as t } from "$lib/i18n";
</script>

<!--
  The navbar's third auth state: the session is not resolved yet.

  Inert on purpose — a `div`, not a button: not focusable, no click target, no
  hover cue, because there is nothing here to act on. `role="status"` with a
  polite live region gives a screen reader the reason the control is missing
  without stealing focus.

  Sized to the avatar trigger it will almost always become (`size-8
  rounded-full`, matching AuthUserDropdown), so the common resolution is a
  fill change with zero layout shift. Its height also matches the `size="sm"`
  Sign In button, so the rarer stale-session resolution shifts horizontally
  only and never changes the navbar's height.

  No spinner: a session that resolves in 80ms would flicker one in and out,
  which reads worse than a quiet neutral shape holding the space.
-->
<div
  data-testid="navbar-auth-pending"
  role="status"
  aria-live="polite"
  aria-label={$t("common.auth.checkingSession", "Checking your session…")}
  class="size-8 rounded-full border border-(--f2z-border-primary) bg-(--f2z-bg-secondary)"
></div>
