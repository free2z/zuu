<script lang="ts">
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Badge } from "$lib/components/ui/badge";
  import * as Select from "$lib/components/ui/select";
  import { Switch } from "$lib/components/ui/switch";
  import * as Card from "$lib/components/ui/card";
  import { Separator } from "$lib/components/ui/separator";
  import {
    Search,
    X,
    ArrowUpDown,
    ShieldCheck,
    CreditCard,
    Hash,
    Users,
    Settings2,
  } from "@lucide/svelte";
  import Button from "$lib/components/ui/button/button.svelte";
  import {
    formatLocalizedNumber,
    isSingularCount,
    locale,
    tStore as t,
  } from "$lib/i18n";
  import {
    creatorsFilterStore,
    activeFilterCount,
    sortOptions,
    sortGroups,
    verifiedOptions,
    membershipOptions,
  } from "$lib/stores/creatorsFilter";

  // Reactive subscriptions - use derived values directly from store
  $: filterCount = $activeFilterCount;
  // Derive values directly from store subscription
  $: searchQuery = $creatorsFilterStore.searchQuery;
  $: sortBy = $creatorsFilterStore.sortBy;
  $: verifiedFilter = $creatorsFilterStore.verifiedFilter;
  $: membershipFilter = $creatorsFilterStore.membershipFilter;
  $: onlyZcash = $creatorsFilterStore.onlyZcash;
  $: minPosts = $creatorsFilterStore.minPosts;
  $: minFollowers = $creatorsFilterStore.minFollowers;

  $: selectedSortOption = sortOptions.find((option) => option.value === sortBy);
  $: sortLabel = selectedSortOption
    ? $t(
        `creators.filters.sortOptions.${selectedSortOption.value}`,
        selectedSortOption.label,
      )
    : $t("creators.filters.sortBy", "Sort by");
  $: selectedVerifiedOption = verifiedOptions.find(
    (option) => option.value === verifiedFilter,
  );
  $: verifiedLabel = selectedVerifiedOption
    ? $t(
        `creators.filters.verificationOptions.${selectedVerifiedOption.value}`,
        selectedVerifiedOption.label,
      )
    : $t("creators.filters.verification", "Verification");
  $: selectedMembershipOption = membershipOptions.find(
    (option) => option.value === membershipFilter,
  );
  $: membershipLabel = selectedMembershipOption
    ? $t(
        `creators.filters.membershipOptions.${selectedMembershipOption.value}`,
        selectedMembershipOption.label,
      )
    : $t("creators.filters.membership", "Membership");

  // Handlers to update store
  function handleSearchChange(value: string) {
    creatorsFilterStore.setSearchQuery(value);
  }

  function handleSortChange(value: string) {
    creatorsFilterStore.setSortBy(value);
  }

  function handleVerifiedChange(value: string) {
    creatorsFilterStore.setVerifiedFilter(
      value as "all" | "verified" | "unverified",
    );
  }

  function handleMembershipChange(value: string) {
    creatorsFilterStore.setMembershipFilter(value as "all" | "free" | "paid");
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
      <Settings2 class="h-4 w-4 text-primary" />
      {#if isMobile}
        <h3 class="text-base font-semibold">
          {$t("creators.filters.filterAndSort", "Filter and sort")}
        </h3>
      {:else}
        <Card.Title class="text-base font-semibold"
          >{$t("creators.filters.filterAndSort", "Filter and sort")}</Card.Title
        >
      {/if}
    </div>
    {#if filterCount > 0}
      <Badge
        variant="secondary"
        class="border-primary/20 bg-primary/10 px-2 py-0.5 text-xs text-primary"
      >
        {isSingularCount(filterCount, $locale)
          ? $t("creators.filters.activeCountOne", "{count} active", {
              count: formatLocalizedNumber(filterCount, $locale),
            })
          : $t("creators.filters.activeCount", "{count} active", {
              count: formatLocalizedNumber(filterCount, $locale),
            })}
      </Badge>
    {/if}
  </div>
{/snippet}

{#snippet searchField(isMobile: boolean)}
  <div class={isMobile ? "space-y-1.5" : "space-y-2"}>
    {#if isMobile}
      <Label
        for="search-creators-mobile"
        class="flex items-center gap-2 text-sm font-medium text-muted-foreground"
      >
        <Search class="h-4 w-4" />
        {$t("common.search.title", "Search")}
      </Label>
    {:else}
      <Label
        for="search-creators"
        class="flex items-center gap-2 text-sm font-medium"
      >
        <Search class="h-4 w-4 text-muted-foreground" />
        {$t("common.search.title", "Search")}
      </Label>
    {/if}
    <div class="group relative">
      <Input
        id={isMobile ? "search-creators-mobile" : "search-creators"}
        placeholder={$t(
          "creators.filters.searchPlaceholder",
          "Type a name or username…",
        )}
        class="border-border/50 bg-background/50 pr-8 {isMobile
          ? ''
          : 'transition-all focus-visible:ring-primary/20'}"
        value={searchQuery}
        oninput={(e) => handleSearchChange(e.currentTarget.value)}
      />
      {#if searchQuery}
        <Button
          variant="ghost"
          class="absolute top-1/2 right-1 h-7 w-7 -translate-y-1/2 rounded-full p-0 text-muted-foreground transition-colors hover:bg-muted/50"
          onclick={() => handleSearchChange("")}
          title={$t("creators.filters.clearSearch", "Clear search")}
        >
          <X class="h-3.5 w-3.5" />
        </Button>
      {/if}
    </div>
  </div>
{/snippet}

{#snippet sortField(isMobile: boolean)}
  <div class={isMobile ? "space-y-1.5" : "space-y-2"}>
    {#if isMobile}
      <Label class="text-xs font-medium text-muted-foreground"
        >{$t("creators.filters.sortBy", "Sort by")}</Label
      >
    {:else}
      <Label class="flex items-center gap-2 text-sm font-medium">
        <ArrowUpDown class="h-4 w-4 text-muted-foreground" />
        {$t("creators.filters.sortBy", "Sort by")}
      </Label>
    {/if}
    <Select.Root
      type="single"
      name={isMobile ? "sortByMobile" : "sortBy"}
      value={sortBy}
      onValueChange={handleSortChange}
    >
      <Select.Trigger
        class="w-full border-border/50 bg-background/50 {isMobile ? 'h-9' : ''}"
      >
        {#if isMobile}
          <div class="truncate">{sortLabel}</div>
        {:else}
          {sortLabel}
        {/if}
      </Select.Trigger>
      <Select.Content class="max-h-[300px]">
        {#each sortGroups as group}
          <Select.Group>
            <Select.GroupHeading
              class="px-2 py-1.5 text-xs font-semibold text-muted-foreground"
              >{$t(
                `creators.filters.sortGroups.${group.key}`,
                group.label,
              )}</Select.GroupHeading
            >
            {#each sortOptions.filter((o) => o.group === group.key) as option}
              <Select.Item
                value={option.value}
                label={$t(
                  `creators.filters.sortOptions.${option.value}`,
                  option.label,
                )}
                class="text-sm"
              >
                {$t(
                  `creators.filters.sortOptions.${option.value}`,
                  option.label,
                )}
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
      <Label class="text-xs font-medium text-muted-foreground"
        >{$t("creators.filters.verification", "Verification")}</Label
      >
    {:else}
      <Label class="flex items-center gap-2 text-sm font-medium">
        <ShieldCheck class="h-4 w-4 text-muted-foreground" />
        {$t("creators.filters.verificationStatus", "Verification status")}
      </Label>
    {/if}
    <Select.Root
      type="single"
      name={isMobile ? "verifiedStatusMobile" : "verifiedStatus"}
      value={verifiedFilter}
      onValueChange={handleVerifiedChange}
    >
      <Select.Trigger
        class="w-full border-border/50 bg-background/50 {isMobile ? 'h-9' : ''}"
      >
        {#if isMobile}
          <div class="truncate">{verifiedLabel}</div>
        {:else}
          {verifiedLabel}
        {/if}
      </Select.Trigger>
      <Select.Content>
        {#each verifiedOptions as option}
          <Select.Item
            value={option.value}
            label={$t(
              `creators.filters.verificationOptions.${option.value}`,
              option.label,
            )}
            class="text-sm"
          >
            {$t(
              `creators.filters.verificationOptions.${option.value}`,
              option.label,
            )}
          </Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </div>
{/snippet}

{#snippet membershipField(isMobile: boolean)}
  <div class={isMobile ? "space-y-1.5" : "space-y-2"}>
    {#if isMobile}
      <Label class="text-xs font-medium text-muted-foreground"
        >{$t("creators.filters.membership", "Membership")}</Label
      >
    {:else}
      <Label class="flex items-center gap-2 text-sm font-medium">
        <CreditCard class="h-4 w-4 text-muted-foreground" />
        {$t("creators.filters.membershipType", "Membership type")}
      </Label>
    {/if}
    <Select.Root
      type="single"
      name={isMobile ? "membershipFilterMobile" : "membershipFilter"}
      value={membershipFilter}
      onValueChange={handleMembershipChange}
    >
      <Select.Trigger
        class="w-full border-border/50 bg-background/50 {isMobile ? 'h-9' : ''}"
      >
        {#if isMobile}
          <div class="truncate">{membershipLabel}</div>
        {:else}
          {membershipLabel}
        {/if}
      </Select.Trigger>
      <Select.Content>
        {#each membershipOptions as option}
          <Select.Item
            value={option.value}
            label={$t(
              `creators.filters.membershipOptions.${option.value}`,
              option.label,
            )}
            class="text-sm"
          >
            {$t(
              `creators.filters.membershipOptions.${option.value}`,
              option.label,
            )}
          </Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </div>
{/snippet}

{#snippet p2pField(isMobile: boolean)}
  {#if isMobile}
    <div class="space-y-1.5">
      <Label class="text-xs font-medium text-muted-foreground"
        >{$t("creators.filters.directDonations", "Direct donations")}</Label
      >
      <div
        class="flex h-9 items-center justify-between rounded-md border border-border/50 bg-background/50 px-2"
      >
        <span class="text-xs text-muted-foreground"
          >{$t("creators.filters.enabled", "Enabled")}</span
        >
        <Switch
          checked={onlyZcash}
          onCheckedChange={handleZcashChange}
          class="origin-right scale-75"
        />
      </div>
    </div>
  {:else}
    <div class="flex items-center justify-between p-3">
      <div class="flex flex-col gap-0.5">
        <Label class="text-sm font-medium"
          >{$t("creators.filters.directDonations", "Direct donations")}</Label
        >
      </div>
      <Switch checked={onlyZcash} onCheckedChange={handleZcashChange} />
    </div>
  {/if}
{/snippet}

{#snippet minPostsField(isMobile: boolean)}
  <div class="space-y-1.5">
    {#if isMobile}
      <Label class="text-xs font-medium text-muted-foreground"
        >{$t("creators.filters.minimumPosts", "Minimum posts")}</Label
      >
    {:else}
      <Label class="flex items-center gap-1 text-xs text-muted-foreground">
        <Hash class="h-3 w-3" />
        {$t("creators.filters.posts", "Posts")}
      </Label>
    {/if}
    <Input
      type="number"
      min="0"
      placeholder={$t("creators.filters.any", "Any")}
      value={minPosts ?? ""}
      oninput={(e) => {
        const val = e.currentTarget.value;
        handleMinPostsChange(val ? parseInt(val) : null);
      }}
      class="h-9 border-border/50 bg-background/50 text-sm"
    />
  </div>
{/snippet}

{#snippet minFollowersField(isMobile: boolean)}
  <div class="space-y-1.5">
    {#if isMobile}
      <Label class="text-xs font-medium text-muted-foreground"
        >{$t("creators.filters.minimumFollowers", "Minimum followers")}</Label
      >
    {:else}
      <Label class="flex items-center gap-1 text-xs text-muted-foreground">
        <Users class="h-3 w-3" />
        {$t("creators.filters.followers", "Followers")}
      </Label>
    {/if}
    <Input
      type="number"
      min="0"
      placeholder={$t("creators.filters.any", "Any")}
      value={minFollowers ?? ""}
      oninput={(e) => {
        const val = e.currentTarget.value;
        handleMinFollowersChange(val ? parseInt(val) : null);
      }}
      class="h-9 border-border/50 bg-background/50 text-sm"
    />
  </div>
{/snippet}

{#snippet resetButton()}
  <Button
    variant="destructive"
    class="w-full"
    onclick={clearFilters}
    disabled={filterCount === 0 && sortBy === "popular"}
  >
    <X class="mr-2 h-4 w-4" />
    {$t("creators.filters.resetAll", "Reset all")}
  </Button>
{/snippet}

<!-- Desktop Version -->
<Card.Root
  class="hidden overflow-hidden border-none bg-transparent shadow-none lg:block lg:border lg:border-border/40 lg:bg-card/50 lg:shadow-md lg:backdrop-blur-sm"
>
  <Card.Header class="pb-4">
    {@render headerBlock(false)}
    <Card.Description class="text-sm text-muted-foreground">
      {$t(
        "creators.filters.description",
        "Find creators that match your interests",
      )}
    </Card.Description>
  </Card.Header>
  <Card.Content class="space-y-5">
    {@render searchField(false)}
    {@render sortField(false)}
    <Separator class="my-2" />
    <div class="space-y-5">
      <p
        class="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
      >
        {$t("creators.filters.title", "Filters")}
      </p>
      {@render verificationField(false)}
      {@render membershipField(false)}
      {@render p2pField(false)}
      <div class="space-y-3">
        <p
          class="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
        >
          {$t("creators.filters.minimumRequirements", "Minimum requirements")}
        </p>
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
<div class="block space-y-4 lg:hidden">
  {@render headerBlock(true)}
  {@render searchField(true)}
  <div class="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
    {@render sortField(true)}
    {@render verificationField(true)}
    {@render membershipField(true)}
    {@render p2pField(true)}
    {@render minPostsField(true)}
    {@render minFollowersField(true)}
  </div>
  {@render resetButton()}
</div>
