<script lang="ts">
  /**
   * Report or block an account from its profile.
   *
   * Blocking is the viewer-side control Play's UGC policy asks for: the API
   * stops serving the blocked account's pages, comments, notifications and
   * chat requests to the blocker (see `py/dj/apps/g12f/blocks.py`). The
   * blocked account is not told.
   */
  import { toast, captureAccountToast } from "$lib/toast.js";
  import { Ban, EllipsisVertical, Flag } from "@lucide/svelte";
  import { buttonVariants, Button } from "$lib/components/ui/button";
  import * as Dialog from "$lib/components/ui/dialog";
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
  } from "$lib/components/ui/dropdown-menu";
  import ReportDialog from "$lib/components/moderation/ReportDialog.svelte";
  import { authStore, currentUser } from "$lib/stores/auth";
  import { requestLogin } from "$lib/stores/auth-modal";
  import { tStore as t } from "$lib/i18n";
  import { readBlocked, setBlocked } from "$lib/moderation";
  import {
    blockRevision,
    blockedUsernames,
    isBlockedIn,
    setLocallyBlocked,
  } from "$lib/stores/blocks";

  let { username }: { username: string } = $props();

  let menuOpen = $state(false);
  let reportOpen = $state(false);
  let confirmOpen = $state(false);
  let saving = $state(false);

  // The shared store is the one answer for "is this account blocked": the
  // banner, the cards and this menu all read it, so they cannot disagree --
  // including after an in-place sign-in, when the store loads the new
  // reader's list while this profile stays mounted.
  let blocked = $derived(isBlockedIn($blockedUsernames, username));

  // Confirm this one account directly, once per signed-in reader and target:
  // the list load may still be in flight, or have failed. An answer that
  // arrives after a write this component made is stale and is dropped.
  let checkedFor = "";
  $effect(() => {
    const reader = $currentUser?.username;
    const target = username;
    const key = reader ? `${reader}\u0000${target}` : "";
    if (!key || key === checkedFor) return;
    checkedFor = key;
    // The store's revision, not a per-component counter: a read started by
    // a menu that has since been destroyed must not override a block a
    // newer menu (or anything else) made in the meantime.
    const revisionAtStart = blockRevision();
    void readBlocked(target).then((state) => {
      if (state === null || blockRevision() !== revisionAtStart) return;
      if ($currentUser?.username !== reader) return;
      setLocallyBlocked(target, state, reader);
    });
  });

  function needsLogin(): boolean {
    if ($authStore.isAuthenticated) return false;
    requestLogin();
    return true;
  }

  function openReport() {
    menuOpen = false;
    if (needsLogin()) return;
    reportOpen = true;
  }

  async function toggleBlock() {
    menuOpen = false;
    if (needsLogin()) return;
    if (!blocked) {
      confirmOpen = true;
      return;
    }
    await apply(false);
  }

  async function apply(next: boolean) {
    const operationNotice = captureAccountToast();
    // Bound to the account this click was about. The parent keys this
    // component by username, but a write still in flight must never apply
    // its answer to whichever profile is showing when it lands.
    const target = username;
    //...and to the account that made it: a response landing after a
    // sign-in as someone else must not edit that account's block list.
    const reader = $currentUser?.username ?? null;
    saving = true;
    const outcome = await setBlocked(target, next);
    saving = false;
    confirmOpen = false;
    if (outcome.ok) {
      setLocallyBlocked(target, outcome.blocked, reader);
      operationNotice.success(
        outcome.blocked
          ? $t("moderation.block.blocked", "You blocked @{username}.", {
              username: target,
            })
          : $t("moderation.block.unblocked", "You unblocked @{username}.", {
              username: target,
            }),
      );
      return;
    }
    if (outcome.reason === "auth") {
      requestLogin();
      return;
    }
    operationNotice.error(
      $t(
        "moderation.block.failed",
        "That did not work. Please try again in a moment.",
      ),
    );
  }
</script>

<DropdownMenu bind:open={menuOpen}>
  <DropdownMenuTrigger
    aria-label={$t("moderation.menu.label", "More actions")}
    title={$t("moderation.menu.label", "More actions")}
    class={buttonVariants({ variant: "outline", size: "icon" })}
    data-testid="profile-moderation-menu"
  >
    <EllipsisVertical class="size-4" />
  </DropdownMenuTrigger>
  <DropdownMenuContent class="w-56" align="end">
    <DropdownMenuItem onclick={openReport} data-testid="profile-report">
      <Flag class="mr-2 h-4 w-4" />
      <span>{$t("moderation.report.titleCreator", "Report account")}</span>
    </DropdownMenuItem>
    <DropdownMenuItem
      onclick={toggleBlock}
      disabled={saving}
      data-testid="profile-block-toggle"
    >
      <Ban class="mr-2 h-4 w-4" />
      <span>
        {blocked
          ? $t("moderation.block.unblockUser", "Unblock @{username}", {
              username,
            })
          : $t("moderation.block.blockUser", "Block @{username}", {
              username,
            })}
      </span>
    </DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>

<ReportDialog bind:open={reportOpen} kind="creator" targetId={username} />

<Dialog.Root bind:open={confirmOpen}>
  <Dialog.Content class="sm:max-w-md" data-testid="block-confirm">
    <Dialog.Header>
      <Dialog.Title>
        {$t("moderation.block.confirmTitle", "Block @{username}?", {
          username,
        })}
      </Dialog.Title>
      <Dialog.Description>
        {$t(
          "moderation.block.confirmDescription",
          "You will stop seeing their pages, comments and notifications, and they will not be able to send you chat requests. They are not told. You can unblock them from their profile at any time.",
        )}
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer class="sm:flex-row">
      <Button variant="outline" onclick={() => (confirmOpen = false)}>
        {$t("common.cancel", "Cancel")}
      </Button>
      <Button
        variant="destructive"
        disabled={saving}
        onclick={() => apply(true)}
        data-testid="block-confirm-submit"
      >
        {$t("moderation.block.confirm", "Block")}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
