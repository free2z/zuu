<script lang="ts">
  import type { PageData } from './$types';
  import { env } from '$env/dynamic/public';
  import { apiFetch } from '$lib/api/config';
  import { authStore } from '$lib/stores/auth';
  import { readErrorMessage } from '$lib/utils/apiErrors';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Textarea } from '$lib/components/ui/textarea';
  import { Label } from '$lib/components/ui/label';
  import { Badge } from '$lib/components/ui/badge';
  import { Switch } from '$lib/components/ui/switch';
  import * as Tooltip from "$lib/components/ui/tooltip/index.js";
    import { Loader2, Save, ShieldCheck, User, Camera, CheckCircle2, InfoIcon } from '@lucide/svelte';
  import { onDestroy } from 'svelte';
  import * as Tabs from "$lib/components/ui/tabs";
  import SecuritySettings from '$lib/components/settings/SecuritySettings.svelte';
  import AccountSettings from '$lib/components/settings/AccountSettings.svelte';

  export let data: PageData;

  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, '') || '';

  const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
  const ALLOWED_FILE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

  let creator = data.creator;

  let fullName = creator.full_name || '';
  let description = creator.description || '';
  let p2paddr = creator.p2paddr || '';
  let memberPrice = creator.member_price || '';
  let updateAll = false;

  let avatarPreview = buildImageUrl(creator.avatar_image);
  let bannerPreview = buildImageUrl(creator.banner_image);
  let avatarFile: File | null = null;
  let bannerFile: File | null = null;

  let isSaving = false;
  let saveError = '';
  let saveSuccess = '';

  let avatarObjectUrl: string | null = null;
  let bannerObjectUrl: string | null = null;

  function buildImageUrl(image: any) {
    if (!image?.url && !image?.thumbnail) return '';
    const imageUrl = image.thumbnail || image.url;
    if (/^https?:\/\//.test(imageUrl)) return imageUrl;
    return `${apiBase}${imageUrl.startsWith('/') ? '' : '/'}${imageUrl}`;
  }

  function validateFile(file: File): string | null {
    if (!ALLOWED_FILE_TYPES.includes(file.type)) {
      return 'Invalid file type. Please upload a JPEG, PNG, WEBP, or GIF image.';
    }
    if (file.size > MAX_FILE_SIZE) {
      return 'File size exceeds 5MB limit.';
    }
    return null;
  }

  function handleAvatarChange(event: Event & { currentTarget: EventTarget & HTMLInputElement }) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;

    const error = validateFile(file);
    if (error) {
      saveError = error;
      input.value = ''; // Reset input
      return;
    }
    saveError = '';

    avatarFile = file;
    if (avatarObjectUrl) URL.revokeObjectURL(avatarObjectUrl);
    avatarObjectUrl = URL.createObjectURL(file);
    avatarPreview = avatarObjectUrl;
  }

  function handleBannerChange(event: Event & { currentTarget: EventTarget & HTMLInputElement }) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;

    const error = validateFile(file);
    if (error) {
      saveError = error;
      input.value = ''; // Reset input
      return;
    }
    saveError = '';

    bannerFile = file;
    if (bannerObjectUrl) URL.revokeObjectURL(bannerObjectUrl);
    bannerObjectUrl = URL.createObjectURL(file);
    bannerPreview = bannerObjectUrl;
  }

  async function uploadImage(file: File, title: string) {
    const body = new FormData();
    body.append('file', file);
    body.append('title', title);
    body.append('access', 'public');
    const response = await apiFetch('/uploads/single-public', {
      method: 'POST',
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || 'Failed to upload image');
    }

    return response.json();
  }

  async function handleSave() {
    saveError = '';
    saveSuccess = '';
    isSaving = true;

    try {
      let avatarImageId: number | null = null;
      let bannerImageId: number | null = null;

      if (avatarFile) {
        const uploadedAvatar = await uploadImage(avatarFile, `${creator.username}-avatar`);
        avatarImageId = uploadedAvatar.id;
      }

      if (bannerFile) {
        const uploadedBanner = await uploadImage(bannerFile, `${creator.username}-banner`);
        bannerImageId = uploadedBanner.id;
      }

      const payload: Record<string, any> = {
        full_name: fullName.trim(),
        description: description.trim(),
        p2paddr: p2paddr.trim(),
        member_price: memberPrice ? String(memberPrice).trim() : null,
      };

      if (updateAll) {
        payload.updateAll = true;
      }

      if (avatarImageId) payload.avatar_image = avatarImageId;
      if (bannerImageId) payload.banner_image = bannerImageId;

      const response = await apiFetch('/api/auth/user/', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorMessage = await readErrorMessage(response, 'Failed to save settings');
        throw new Error(errorMessage);
      }

      creator = await response.json();
      authStore.updateCreator?.(creator);

      if (avatarObjectUrl) {
        URL.revokeObjectURL(avatarObjectUrl);
        avatarObjectUrl = null;
      }
      if (bannerObjectUrl) {
        URL.revokeObjectURL(bannerObjectUrl);
        bannerObjectUrl = null;
      }
      avatarPreview = buildImageUrl(creator.avatar_image);
      bannerPreview = buildImageUrl(creator.banner_image);

      avatarFile = null;
      bannerFile = null;
      saveSuccess = 'Profile updated successfully.';
      
      // Clear success message after 3 seconds
      setTimeout(() => saveSuccess = '', 3000);
      
    } catch (err: any) {
      saveError = err?.message || 'Failed to save settings.';
    } finally {
      isSaving = false;
    }
  }

  onDestroy(() => {
    if (avatarObjectUrl) URL.revokeObjectURL(avatarObjectUrl);
    if (bannerObjectUrl) URL.revokeObjectURL(bannerObjectUrl);
  });
</script>

<svelte:head>
  <title>Settings • {creator.username}</title>
  <meta name="description" content="Update your profile, address, and images." />
</svelte:head>

<main class="flex-1 bg-background text-foreground pb-20">
  <div class="container max-w-6xl mx-auto py-10">
    
    <header class="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-8">
      <div class="space-y-1">
        <div class="flex items-center gap-3">
          <h1 class="text-3xl font-bold tracking-tight">Settings</h1>
          {#if creator.is_verified}
             <Badge variant="secondary" class="text-blue-600 bg-blue-100 hover:bg-blue-100/80 dark:bg-blue-900/30 dark:text-blue-400 border-transparent">
               <ShieldCheck class="size-3.5 mr-1" /> Verified
             </Badge>
          {/if}
        </div>
        <p class="text-muted-foreground">
          Manage your account settings and set e-mail preferences.
        </p>
      </div>

      <div class="flex items-center gap-4">
          <div class="hidden lg:flex items-center gap-3 mr-2">
              {#if saveError}
                 <div class="text-destructive font-medium text-sm animate-in fade-in slide-in-from-top-1">{saveError}</div>
              {/if}
              {#if saveSuccess}
                 <div class="text-green-600 font-medium text-sm animate-in fade-in slide-in-from-top-1 flex items-center">
                    <CheckCircle2 class="size-4 mr-2" /> {saveSuccess}
                 </div>
              {/if}
          </div>
          <Button href={`/${creator.username}`} variant="ghost">Discard</Button>
          <Button onclick={handleSave} disabled={isSaving}>
             {#if isSaving}
               <Loader2 class="size-4 animate-spin mr-2" /> Saving...
             {:else}
               <Save class="size-4 mr-2" /> Save Changes
             {/if}
          </Button>
      </div>
    </header>

    <div class="flex flex-col lg:flex-row gap-8">
      <!-- Sidebar Profile Section -->
      <aside class="w-full lg:w-80 shrink-0 space-y-6">
        <div class="relative rounded-xl overflow-hidden border bg-background shadow-sm">
          <div class="h-32 w-full relative bg-muted">
            {#if bannerPreview}
              <img src={bannerPreview} alt="Banner" class="h-full w-full object-cover" />
            {/if}
            <div class="absolute inset-0 bg-black/20 opacity-0 hover:opacity-100 transition-opacity flex items-center justify-center">
              <div class="relative">
                <Button variant="secondary" size="sm" class="pointer-events-none">
                  <Camera class="size-4 mr-2" /> Edit
                </Button>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  on:change={handleBannerChange}
                  class="absolute inset-0 opacity-0 cursor-pointer"
                  aria-label="Upload banner image"
                />
              </div>
            </div>
          </div>

          <div class="px-6 pb-6 relative z-10">
            <div class="flex flex-col items-center -mt-12 mb-4">
              <div class="relative group/avatar mb-3">
                <div class="h-24 w-24 rounded-xl border-4 border-background bg-muted overflow-hidden shadow-sm">
                  {#if avatarPreview}
                    <img src={avatarPreview} alt="Avatar" class="h-full w-full object-cover" />
                  {:else}
                    <div class="h-full w-full flex items-center justify-center text-muted-foreground bg-muted">
                      <User class="size-8" />
                    </div>
                  {/if}
                </div>
                <div class="absolute inset-0 rounded-xl bg-black/20 opacity-0 hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer">
                  <Camera class="size-6 text-white" />
                  <input
                    type="file"
                    accept="image/*"
                    on:change={handleAvatarChange}
                    class="absolute inset-0 opacity-0 cursor-pointer"
                    aria-label="Upload avatar"
                  />
                </div>
              </div>

              <div class="text-center">
                <h2 class="text-xl font-bold truncate max-w-60">{fullName || creator.username}</h2>
                <p class="text-sm text-muted-foreground">@{creator.username}</p>
              </div>
            </div>

            <div class="space-y-4 pt-2 border-t">
              <div class="grid gap-2">
                <Label for="fullName">Display Name</Label>
                <Input id="fullName" bind:value={fullName} placeholder="Your name" />
              </div>

              <div class="grid gap-2">
                <Label for="bio">Biography</Label>
                <Textarea id="bio" rows={4} bind:value={description} placeholder="Tell us about yourself" />
              </div>
            </div>
          </div>
        </div>
      </aside>

      <!-- Main Content Tabs -->
      <div class="flex-1 min-w-0">
        <Tabs.Root value="financial" class="w-full space-y-6">
          <Tabs.List>
            <Tabs.Trigger value="financial">Financial</Tabs.Trigger>
            <Tabs.Trigger value="security">Security</Tabs.Trigger>
            <Tabs.Trigger value="account">Account</Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value="financial" class="space-y-6">
          <div class="space-y-6">
              <div>
                  <h3 class="text-lg font-medium">Payout Settings</h3>
                  <p class="text-sm text-muted-foreground">Configure your Zcash address and membership pricing.</p>
              </div>
              
              <div class="grid gap-6">
                  <div class="grid gap-2">
                      <Label for="zcash">Zcash Address</Label>
                      <Input id="zcash" bind:value={p2paddr} placeholder="zs1..." class="font-mono" />

                          <div class="flex items-center space-x-2">
                            <Switch id="updateAll" bind:checked={updateAll} />
                            <Label for="updateAll" class="font-normal">Apply to all existing articles</Label>
  <Tooltip.Root>
    <Tooltip.Trigger 
      ><InfoIcon class="size-3 text-muted-foreground cursor-pointer"/></Tooltip.Trigger
    >
    <Tooltip.Content>
      <p> When enabled, this will update the payout address on all of your existing articles. Use with caution.</p>
    </Tooltip.Content>
  </Tooltip.Root>
                          </div>

                  </div>

                  <div class="grid gap-2 max-w-sm">
                      <Label for="memberPrice">Membership Price (ZEC)</Label>
                      <div class="relative">
                         <Input
                           id="memberPrice"
                           type="number"
                           min="0"
                           step="1"
                           bind:value={memberPrice}
                           placeholder="0"
                           class="pl-16"
                           oninput={(e) => {
                             const target = e.currentTarget as HTMLInputElement;
                             const raw = target.value;
                             if (raw === '') {
                               memberPrice = '';
                               return;
                             }
                             const num = Number(raw);
                             if (Number.isNaN(num)) {
                               memberPrice = '0';
                               target.value = '0';
                               return;
                             }
                             const clamped = Math.max(0, Math.floor(num));
                             memberPrice = String(clamped);
                             target.value = memberPrice;
                           }}
                         />
                         <div class="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm font-medium">ZEC</div>
                      </div>
                      <p class="text-sm text-muted-foreground">
                          Set to 0 for free access.
                      </p>
                  </div>
              </div>
          </div>
      </Tabs.Content>

      <Tabs.Content value="security" class="space-y-6">
        <SecuritySettings initialMfaEnabled={Boolean((creator as any)?.mfa_enabled)} />
      </Tabs.Content>
      <Tabs.Content value="account" class="space-y-6">
        <AccountSettings username={creator.username} initialEmail={creator.email} />
      </Tabs.Content>
    </Tabs.Root>
      </div>
    </div>
  </div>
</main>

