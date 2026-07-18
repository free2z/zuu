<script lang="ts">
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Badge } from "$lib/components/ui/badge";
  import * as Select from "$lib/components/ui/select";
  import { Switch } from "$lib/components/ui/switch";
  import * as Card from "$lib/components/ui/card";
  import { Separator } from "$lib/components/ui/separator";
  import { Search, X, ArrowUpDown, ShieldCheck, CreditCard, Hash, Users, Settings2 } from "@lucide/svelte";
  import Button from '$lib/components/ui/button/button.svelte';
  import {
    creatorsFilterStore,
    activeFilterCount,
    sortOptions,
    sortGroups,
    verifiedOptions,
    membershipOptions,
    sortTriggerContent,
    verifiedTriggerContent,
    membershipTriggerContent
  } from '$lib/stores/creatorsFilter';

  // Reactive subscriptions - use derived values directly from store
  $: filterCount = $activeFilterCount;
  $: sortLabel = $sortTriggerContent;
  $: verifiedLabel = $verifiedTriggerContent;
  $: membershipLabel = $membershipTriggerContent;

  // Derive values directly from store subscription
  $: searchQuery = $creatorsFilterStore.searchQuery;
  $: sortBy = $creatorsFilterStore.sortBy;
  $: verifiedFilter = $creatorsFilterStore.verifiedFilter;
  $: membershipFilter = $creatorsFilterStore.membershipFilter;
  $: onlyZcash = $creatorsFilterStore.onlyZcash;
  $: minPosts = $creatorsFilterStore.minPosts;
  $: minFollowers = $creatorsFilterStore.minFollowers;

  // Handlers to update store
  function handleSearchChange(value: string) {
    creatorsFilterStore.setSearchQuery(value);
  }

  function handleSortChange(value: string) {
    creatorsFilterStore.setSortBy(value);
  }

  function handleVerifiedChange(value: string) {
    creatorsFilterStore.setVerifiedFilter(value as 'all' | 'verified' | 'unverified');
  }

  function handleMembershipChange(value: string) {
    creatorsFilterStore.setMembershipFilter(value as 'all' | 'free' | 'paid');
  }

  function handleZcashChange(checked: boolean) {
    creatorsFilterStore.setOnlyZcash(checked);
  }

  function handleMinPostsChange(value: number | null) {
    creatorsFilterStore.setMinPosts(value);
  }

  function handleMinFollowersChange(value: number | null) {
    creatorsFilterStore.setMinFollowers(value);
  }

  function clearFilters() {
    creatorsFilterStore.clearFilters();
  }
</script>

{#snippet headerBlock(isMobile: boolean)}
    <div class="flex items-center justify-between {isMobile ? '' : 'mb-2'}">
        <div class="flex items-center gap-2">
            <Settings2 class="w-4 h-4 text-primary" />
            {#if isMobile}
                <h3 class="text-base font-semibold">Filter & Sort</h3>
            {:else}
                <Card.Title class="text-base font-semibold">Filter & Sort</Card.Title>
            {/if}
        </div>
        {#if filterCount > 0}
            <Badge variant="secondary" class="text-xs px-2 py-0.5 bg-primary/10 text-primary border-primary/20">
                {filterCount} active
            </Badge>
        {/if}
    </div>
{/snippet}

{#snippet searchField(isMobile: boolean)}
    <div class={isMobile ? "space-y-1.5" : "space-y-2"}>
         {#if isMobile}
             <Label for="search-creators-mobile" class="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Search class="w-4 h-4" />
                Search
             </Label>
         {:else}
            <Label for="search-creators" class="text-sm font-medium flex items-center gap-2">
                <Search class="w-4 h-4 text-muted-foreground" />
                Search
            </Label>
         {/if}
        <div class="relative group">
            <Input 
                id={isMobile ? "search-creators-mobile" : "search-creators"}
                placeholder="Type a name or username..." 
                class="bg-background/50 border-border/50 pr-8 {isMobile ? '' : 'focus-visible:ring-primary/20 transition-all'}"
                value={searchQuery}
                oninput={(e) => handleSearchChange(e.currentTarget.value)}
            />
            {#if searchQuery}
                <Button 
                    variant="ghost"
                    class="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0 rounded-full hover:bg-muted/50 transition-colors text-muted-foreground"
                    onclick={() => handleSearchChange('')}
                    title="Clear search"
                >
                    <X class="w-3.5 h-3.5" />
                </Button>
            {/if}
        </div>
    </div>
{/snippet}

{#snippet sortField(isMobile: boolean)}
    <div class={isMobile ? "space-y-1.5" : "space-y-2"}>
        {#if isMobile}
            <Label class="text-xs font-medium text-muted-foreground">Sort by</Label>
        {:else}
            <Label class="text-sm font-medium flex items-center gap-2">
                <ArrowUpDown class="w-4 h-4 text-muted-foreground" />
                Sort by
            </Label>
        {/if}
        <Select.Root type="single" name={isMobile ? "sortByMobile" : "sortBy"} value={sortBy} onValueChange={handleSortChange}>
            <Select.Trigger class="w-full bg-background/50 border-border/50 {isMobile ? 'h-9' : ''}">
                {#if isMobile}
                    <div class="truncate">{sortLabel}</div>
                {:else}
                    {sortLabel}
                {/if}
            </Select.Trigger>
            <Select.Content class="max-h-[300px]">
                {#each sortGroups as group}
                    <Select.Group>
                        <Select.GroupHeading class="text-xs font-semibold text-muted-foreground px-2 py-1.5">{group.label}</Select.GroupHeading>
                        {#each sortOptions.filter(o => o.group === group.key) as option}
                            <Select.Item value={option.value} label={option.label} class="text-sm">
                                {option.label}
                            </Select.Item>
                        {/each}
                    </Select.Group>
                {/each}
            </Select.Content>
        </Select.Root>
    </div>
{/snippet}

{#snippet verificationField(isMobile: boolean)}
    <div class={isMobile ? "space-y-1.5" : "space-y-2"}>
        {#if isMobile}
            <Label class="text-xs font-medium text-muted-foreground">Verification</Label>
        {:else}
            <Label class="text-sm font-medium flex items-center gap-2">
                <ShieldCheck class="w-4 h-4 text-muted-foreground" />
                Verification Status
            </Label>
        {/if}
        <Select.Root type="single" name={isMobile ? "verifiedStatusMobile" : "verifiedStatus"} value={verifiedFilter} onValueChange={handleVerifiedChange}>
            <Select.Trigger class="w-full bg-background/50 border-border/50 {isMobile ? 'h-9' : ''}">
                {#if isMobile}
                    <div class="truncate">{verifiedLabel}</div>
                {:else}
                    {verifiedLabel}
                {/if}
            </Select.Trigger>
            <Select.Content>
                {#each verifiedOptions as option}
                    <Select.Item value={option.value} label={option.label} class="text-sm">
                        {option.label}
                    </Select.Item>
                {/each}
            </Select.Content>
        </Select.Root>
    </div>
{/snippet}

{#snippet membershipField(isMobile: boolean)}
    <div class={isMobile ? "space-y-1.5" : "space-y-2"}>
        {#if isMobile}
            <Label class="text-xs font-medium text-muted-foreground">Membership</Label>
        {:else}
            <Label class="text-sm font-medium flex items-center gap-2">
                <CreditCard class="w-4 h-4 text-muted-foreground" />
                Membership Type
            </Label>
        {/if}
        <Select.Root type="single" name={isMobile ? "membershipFilterMobile" : "membershipFilter"} value={membershipFilter} onValueChange={handleMembershipChange}>
            <Select.Trigger class="w-full bg-background/50 border-border/50 {isMobile ? 'h-9' : ''}">
                {#if isMobile}
                    <div class="truncate">{membershipLabel}</div>
                {:else}
                    {membershipLabel}
                {/if}
            </Select.Trigger>
            <Select.Content>
                {#each membershipOptions as option}
                    <Select.Item value={option.value} label={option.label} class="text-sm">
                        {option.label}
                    </Select.Item>
                {/each}
            </Select.Content>
        </Select.Root>
    </div>
{/snippet}

{#snippet p2pField(isMobile: boolean)}
    {#if isMobile}
        <div class="space-y-1.5">
            <Label class="text-xs font-medium text-muted-foreground">Direct Donations</Label>
            <div class="flex items-center justify-between border border-border/50 rounded-md px-2 h-9 bg-background/50">
                <span class="text-xs text-muted-foreground">Enabled</span>
                <Switch checked={onlyZcash} onCheckedChange={handleZcashChange} class="scale-75 origin-right" />
            </div>
        </div>
    {:else}
        <div class="flex items-center justify-between p-3">
            <div class="flex flex-col gap-0.5">
                <Label class="text-sm font-medium cursor-pointer">Direct Donations</Label>
            </div>
            <Switch checked={onlyZcash} onCheckedChange={handleZcashChange} />
        </div>
    {/if}
{/snippet}

{#snippet minPostsField(isMobile: boolean)}
    <div class="space-y-1.5">
        {#if isMobile}
            <Label class="text-xs font-medium text-muted-foreground">Min Posts</Label>
        {:else}
            <Label class="text-xs text-muted-foreground flex items-center gap-1">
                <Hash class="w-3 h-3" />
                Posts
            </Label>
        {/if}
        <Input 
            type="number" 
            min="0" 
            placeholder="Any" 
            value={minPosts ?? ''} 
            oninput={(e) => {
                const val = e.currentTarget.value;
                handleMinPostsChange(val ? parseInt(val) : null);
            }}
            class="bg-background/50 border-border/50 h-9 text-sm" 
        />
    </div>
{/snippet}

{#snippet minFollowersField(isMobile: boolean)}
    <div class="space-y-1.5">
        {#if isMobile}
            <Label class="text-xs font-medium text-muted-foreground">Min Followers</Label>
        {:else}
            <Label class="text-xs text-muted-foreground flex items-center gap-1">
                <Users class="w-3 h-3" />
                Followers
            </Label>
        {/if}
        <Input 
            type="number" 
            min="0" 
            placeholder="Any" 
            value={minFollowers ?? ''} 
            oninput={(e) => {
                const val = e.currentTarget.value;
                handleMinFollowersChange(val ? parseInt(val) : null);
            }}
            class="bg-background/50 border-border/50 h-9 text-sm" 
        />
    </div>
{/snippet}

{#snippet resetButton()}
    <Button 
        variant="destructive" 
        class="w-full"
        onclick={clearFilters} 
        disabled={filterCount === 0 && sortBy === 'popular'}
    >
        <X class="w-4 h-4 mr-2" />
        Reset All
    </Button>
{/snippet}

<!-- Desktop Version -->
<Card.Root class="hidden lg:block border-none shadow-none bg-transparent lg:bg-card/50 lg:backdrop-blur-sm lg:border lg:border-border/40 lg:shadow-md overflow-hidden">
    <Card.Header class="pb-4">
        {@render headerBlock(false)}
        <Card.Description class="text-sm text-muted-foreground">
            Find the perfect creators for you
        </Card.Description>
    </Card.Header>
    <Card.Content class="space-y-5">
        {@render searchField(false)}
        {@render sortField(false)}
        <Separator class="my-2" />
        <div class="space-y-5">
            <p class="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Filters</p>
            {@render verificationField(false)}
            {@render membershipField(false)}
            {@render p2pField(false)}
            <div class="space-y-3">
                <p class="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Minimum Requirements</p>
                <div class="grid grid-cols-2 gap-3">
                    {@render minPostsField(false)}
                    {@render minFollowersField(false)}
                </div>
            </div>
        </div>
    </Card.Content>
    <Card.Footer class="pt-4">
        {@render resetButton()}
    </Card.Footer>
</Card.Root>

<!-- Mobile Version -->
<div class="block lg:hidden space-y-4">
    {@render headerBlock(true)}
    {@render searchField(true)}
    <div class="grid sm:grid-cols-2 md:grid-cols-3 gap-3">
        {@render sortField(true)}
        {@render verificationField(true)}
        {@render membershipField(true)}
        {@render p2pField(true)}
        {@render minPostsField(true)}
        {@render minFollowersField(true)}
    </div>
    {@render resetButton()}
</div>
