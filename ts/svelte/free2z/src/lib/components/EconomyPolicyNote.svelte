<script lang="ts">
  import { onMount } from "svelte";
  import { apiFetch } from "$lib/api/config";
  import { tStore as t } from "$lib/i18n";
  let state: "unknown" | "legacy" | "active" = "unknown";
  onMount(async () => {
    try {
      const response = await apiFetch("/api/economy/capabilities/");
      if (!response.ok) return;
      const value = await response.json();
      if (value.policy_version === 0) state = "legacy";
      else if (
        value.policy_version === 1 &&
        value.active &&
        value.creator_compensation_available
      )
        state = "active";
    } catch {
      /* Unknown availability must not imply an earnings entitlement. */
    }
  });
</script>

<p class="text-sm text-muted-foreground" data-testid="economy-policy-note">
  {$t(
    state === "legacy"
      ? "economy.policyLegacy"
      : state === "active"
        ? "economy.policyActive"
        : "economy.policyUnknown",
  )}
</p>
