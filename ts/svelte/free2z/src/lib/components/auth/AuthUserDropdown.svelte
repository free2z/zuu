<script lang="ts">
  import { authStore, currentUser } from "$lib/stores/auth";
  import { tStore as t } from "$lib/i18n";
  import Button from "$lib/components/ui/button/button.svelte";
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
  } from "$lib/components/ui/dropdown-menu";
  import {
    Avatar,
    AvatarFallback,
    AvatarImage,
  } from "$lib/components/ui/avatar";
  import {
    LogOut,
    User,
    Settings,
    CreditCard,
    ShieldCheck,
    SquarePen,
  } from "@lucide/svelte";
  import GitHubBrandIcon from "$lib/components/GitHubBrandIcon.svelte";
  import { goto } from "$app/navigation";
  import { toast, captureAccountToast } from "$lib/toast.js";
  const navItemIconClass =
    'data-[highlighted]:[&_svg:not([class*="text-"])]:text-accent-foreground dark:data-[highlighted]:text-background dark:data-[highlighted]:[&_svg:not([class*="text-"])]:text-background';

  let { open = $bindable(false) }: { open?: boolean } = $props();

  // Handle logout
  async function handleLogout() {
    const operationNotice = captureAccountToast();
    const loggedOut = await authStore.logout();
    if (!loggedOut) {
      operationNotice.error(
        $t(
          "common.auth.logoutFailed",
          "Could not log out. Your session is still active; please try again.",
        ),
      );
    }
  }

  function getAvatarUrl(user: any): string {
    if (!user?.avatar_image) return "";
    const avatar = user.avatar_image.thumbnail || user.avatar_image.url;
    if (!avatar) return "";
    if (avatar.startsWith("/")) {
      return avatar;
    }
    return avatar;
  }

  function getUserInitials(user: any): string {
    if (user?.full_name) {
      const names = user.full_name.split(" ");
      return names
        .map((n: string) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2);
    }
    if (user?.username) return user.username.slice(0, 2).toUpperCase();
    return "U";
  }
</script>

{#if $currentUser}
  <DropdownMenu bind:open>
    <DropdownMenuTrigger>
      {#snippet child({ props })}
        <Button
          {...props}
          variant="ghost"
          class="relative h-8 w-8 rounded-full"
          aria-label={$t("auth.profile", "Profile")}
          data-testid="navbar-profile-trigger"
        >
          <Avatar class="h-8 w-8">
            <AvatarImage
              src={getAvatarUrl($currentUser)}
              alt={$currentUser.username}
            />
            <AvatarFallback>{getUserInitials($currentUser)}</AvatarFallback>
          </Avatar>
        </Button>
      {/snippet}
    </DropdownMenuTrigger>

    <DropdownMenuContent class="w-56" align="end">
      <!-- User Info -->
      <div class="flex items-center justify-start gap-2 p-2">
        <div class="flex flex-col space-y-1 leading-none">
          {#if $currentUser.full_name}
            <p class="font-medium">{$currentUser.full_name}</p>
          {/if}
          <p class="w-[200px] truncate text-sm text-muted-foreground">
            @{$currentUser.username}
          </p>
        </div>
      </div>

      <DropdownMenuSeparator />

      <!-- New post — the fast path to the editor  -->
      <DropdownMenuItem
        class={navItemIconClass}
        data-testid="user-menu-new-post"
        onSelect={() =>
          goto(
            `/edit?newPost=${Date.now()}-${Math.random().toString(36).slice(2)}`,
          )}
      >
        <SquarePen class="mr-2 h-4 w-4" />
        <span>{$t("common.navigation.newPost", "New post")}</span>
      </DropdownMenuItem>

      <DropdownMenuSeparator />

      <!-- Profile Link -->
      <DropdownMenuItem
        class={navItemIconClass}
        onSelect={() => goto(`/${$currentUser.username}/dashboard/profile`)}
      >
        <User class="mr-2 h-4 w-4" />
        <span>{$t("common.auth.profile", "Profile")}</span>
      </DropdownMenuItem>

      <!-- Settings Link -->
      <DropdownMenuItem
        class={navItemIconClass}
        onSelect={() => goto(`/${$currentUser.username}/dashboard/settings`)}
      >
        <Settings class="mr-2 h-4 w-4" />
        <span>{$t("common.auth.settings", "Settings")}</span>
      </DropdownMenuItem>

      <!-- Credits Link -->
      <DropdownMenuItem
        class={navItemIconClass}
        onSelect={() => goto(`/${$currentUser.username}/dashboard/billing`)}
      >
        <CreditCard class="mr-2 h-4 w-4" />
        <span>{$t("common.auth.billing", "Credits")}</span>
      </DropdownMenuItem>

      <!--
        Revenue-share verification. This entry is the whole reason a migrated
        creator can find KYC at all: the classic stepper was reachable from the
        classic profile page, and after switching UIs there was no route back
        .
      -->
      <DropdownMenuItem
        class={navItemIconClass}
        onSelect={() => goto(`/${$currentUser.username}/dashboard/kyc`)}
      >
        <ShieldCheck class="mr-2 h-4 w-4" />
        <span>{$t("common.auth.revenueShare", "Creator verification")}</span>
      </DropdownMenuItem>

      <!-- Contribute Link -->
      <DropdownMenuItem
        class={navItemIconClass}
        onSelect={() => window.open("https://github.com/free2z/zuu", "_blank")}
      >
        <GitHubBrandIcon class="mr-2 h-4 w-4" />
        <span>{$t("common.auth.contribute", "Contribute")}</span>
      </DropdownMenuItem>

      <DropdownMenuSeparator />

      <!-- Logout -->
      <DropdownMenuItem variant="destructive" onSelect={handleLogout}>
        <LogOut class="mr-2 h-4 w-4" />
        <span>{$t("common.auth.logout", "Log out")}</span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
{/if}
