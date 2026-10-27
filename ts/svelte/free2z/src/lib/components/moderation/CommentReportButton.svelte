<script lang="ts">
  /**
   * The per-comment report control, shared by the zPage comment
   * card and Converse posts so every comment surface can be reported.
   * Hidden on the reader's own comments; a signed-out reader is asked to
   * sign in first.
   */
  import { Flag } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button";
  import ReportDialog from "./ReportDialog.svelte";
  import { authStore, currentUser } from "$lib/stores/auth";
  import { requestLogin } from "$lib/stores/auth-modal";
  import { tStore as t } from "$lib/i18n";

  let {
    commentUuid,
    authorUsername,
    class: className = "",
  }: { commentUuid: string; authorUsername: string; class?: string } = $props();

  let open = $state(false);
  let isOwn = $derived(
    !!$currentUser?.username && $currentUser.username === authorUsername,
  );

  function openReport() {
    if (!$authStore.isAuthenticated) {
      requestLogin();
      return;
    }
    open = true;
  }
</script>

{#if !isOwn}
  <Button
    variant="ghost"
    size="sm"
    class="ml-auto h-8 rounded-lg bg-transparent px-2 text-muted-foreground hover:bg-transparent hover:text-destructive dark:hover:bg-transparent {className}"
    onclick={openReport}
    title={$t("moderation.report.titleComment", "Report comment")}
    aria-label={$t("moderation.report.titleComment", "Report comment")}
    data-testid="comment-report"
  >
    <Flag strokeWidth={1.5} class="size-4" />
  </Button>
  <ReportDialog bind:open kind="comment" targetId={commentUuid} />
{/if}
