<script lang="ts">
  import { authStore, currentUser } from '$lib/stores/auth';
  import { t } from '$lib/i18n';
  import Button from '$lib/components/ui/button/button.svelte';
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
  } from '$lib/components/ui/dropdown-menu';
  import {
    Avatar,
    AvatarFallback,
    AvatarImage,
  } from '$lib/components/ui/avatar';
  import { LogOut, User, Settings, CreditCard, Github } from '@lucide/svelte';
   import { goto } from '$app/navigation';
  import { classicUiAvailable, switchToClassicUi } from '$lib/utils/classic-ui';

  const showClassicLink = classicUiAvailable();

  // Handle logout
  async function handleLogout() {
    await authStore.logout();
  }

  function getAvatarUrl(user: any): string {
    if (!user?.avatar_image) return '';
    const avatar = user.avatar_image.thumbnail || user.avatar_image.url;
    if (!avatar) return '';
    if (avatar.startsWith('/')) {
      return avatar;
    }
    return avatar;
  }

  function getUserInitials(user: any): string {
    if (user?.full_name) {
      const names = user.full_name.split(' ');
      return names.map((n: string) => n[0]).join('').toUpperCase().slice(0, 2);
    }
    if (user?.username) return user.username.slice(0, 2).toUpperCase();
    return 'U';
  }
</script>

{#if $currentUser}
  <DropdownMenu>
    <DropdownMenuTrigger>
      <Button variant="ghost" class="relative h-8 w-8 rounded-full">
        <Avatar class="h-8 w-8">
          <AvatarImage
            src={getAvatarUrl($currentUser)}
            alt={$currentUser.username}
          />
          <AvatarFallback>{getUserInitials($currentUser)}</AvatarFallback>
        </Avatar>
      </Button>
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

      <!-- Profile Link -->
      <DropdownMenuItem onSelect={() => goto(`/${$currentUser.username}/dashboard/profile`)} >
        <User class="mr-2 h-4 w-4" />
        <span>{t('common.auth.profile', 'Profile')}</span>
      </DropdownMenuItem>

      <!-- Settings Link -->
      <DropdownMenuItem onSelect={() => goto(`/${$currentUser.username}/dashboard/settings`)}>
        <Settings class="mr-2 h-4 w-4" />
        <span>{t('common.auth.settings', 'Settings')}</span>
      </DropdownMenuItem>

      <!-- Billing Link -->
      <DropdownMenuItem onSelect={() => goto(`/${$currentUser.username}/dashboard/billing`)}>
        <CreditCard class="mr-2 h-4 w-4" />
        <span>{t('common.auth.billing', 'Billing')}</span>
      </DropdownMenuItem>

      <!-- Contribute Link -->
      <DropdownMenuItem onSelect={() => window.open('https://github.com/free2z/zuu/tree/main/ts/react/free2z', '_blank')}>
        <Github class="mr-2 h-4 w-4" />
        <span>{t('common.auth.contribute', 'Contribute')}</span>
      </DropdownMenuItem>

      {#if showClassicLink}
        <!-- Back to the classic UI (nginx clears the f2z_ui cookie) -->
        <DropdownMenuItem class="group" onSelect={switchToClassicUi}>
          <img
            src="/logo512.png"
            alt=""
            class="mr-2 size-4 object-contain grayscale opacity-60 transition-all duration-200 group-hover:scale-110 group-hover:grayscale-0 group-hover:opacity-100 group-focus:scale-110 group-focus:grayscale-0 group-focus:opacity-100"
          />
          <span>{t('common.auth.classicSite', 'Switch to classic site')}</span>
        </DropdownMenuItem>
      {/if}

      <DropdownMenuSeparator />

      <!-- Logout -->
      <DropdownMenuItem variant='destructive' onSelect={handleLogout}>
        <LogOut class="mr-2 h-4 w-4" />
        <span>{t('common.auth.logout', 'Log out')}</span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
{/if}
