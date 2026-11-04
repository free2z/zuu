<script lang="ts">
  import type { PageData } from "./$types";
  import * as env from "$app/env/public";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { goto } from "$app/navigation";
  import LiveIndicator from "$lib/components/stream/LiveIndicator.svelte";
  import { Badge } from "$lib/components/ui/badge";
  import {
    CheckCircle2,
    FileText,
    MessagesSquare,
    Settings,
    LayoutGrid,
    PenLine,
    Search,
  } from "@lucide/svelte";
  import * as Tabs from "$lib/components/ui/tabs";
  import * as Select from "$lib/components/ui/select";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import ZpageCard from "$lib/components/ZpageCard.svelte";
  import TagFilter from "$lib/components/TagFilter.svelte";
  // @ts-ignore
  import CustomPagination from "$lib/components/CustomPagination.svelte";
  import MarkdownContent from "$lib/components/MarkdownContent.svelte";
  import { processMarkdown } from "$lib/utils/markdown";
  import { useFirstPartyCards } from "$lib/first-party-card-resolver";
  import { parseBioFrontmatter, sameAsUrls } from "$lib/utils/bio";
  import SocialLinks from "$lib/components/profile/SocialLinks.svelte";
  import ProfileDonate from "$lib/components/profile/ProfileDonate.svelte";
  import ProfileSubscribe from "$lib/components/profile/ProfileSubscribe.svelte";
  import ProfileShare from "$lib/components/profile/ProfileShare.svelte";
  import ProfileModerationMenu from "$lib/components/profile/ProfileModerationMenu.svelte";
  import { blockedUsernames, isBlockedIn } from "$lib/stores/blocks";
  import ImageLightbox from "$lib/components/profile/ImageLightbox.svelte";
  import ProfileConversePosts from "$lib/components/profile/ProfileConversePosts.svelte";
  import { page } from "$lib/kit-stores";
  import SeoHead from "$lib/components/SeoHead.svelte";
  import { CANONICAL_ORIGIN, compactText, toAbsoluteUrl } from "$lib/seo";
  import { isSingularCount, locale, tStore as t } from "$lib/i18n";

  export let data: PageData & {
    isOwner: boolean;
    tags?: { name: string; count: number }[];
  };

  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";
  const canonicalOrigin =
    env.PUBLIC_CANONICAL_BASE_URL?.replace(/\/$/, "") || CANONICAL_ORIGIN;

  $: creator = data.creator;
  $: zpages = data.zpages?.results || [];
  $: next = data.zpages?.next;
  $: previous = data.zpages?.previous;
  $: totalCount = data.zpages?.count || 0;
  $: isOwner = data.isOwner;
  $: viewerBlocked =
    !isOwner && isBlockedIn($blockedUsernames, creator?.username);
  $: availableTags = data.tags || [];

  // The profile endpoint is published-only for every viewer, including the
  // owner. Draft access belongs to the dashboard and editor routes.
  $: publishedPages = zpages;
  $: publishedCount = data.zpages?.count ?? 0;

  $: currentPage = parseInt($page.url.searchParams.get("page") || "1");
  $: currentSearch = $page.url.searchParams.get("search") || "";
  $: currentSort = $page.url.searchParams.get("ordering") || "-published_at";
  $: currentTag = $page.url.searchParams.get("tag") || "";

  // Which owner tab is open. Publications use the `?page=` article pager;
  // the Posts tab loads by cursor and must not show it.
  let ownerTab = "published";
  // Same idea on the public view, where the article search/sort/tag controls
  // sit above both tabs.
  let publicTab = "articles";
  // `Tabs.Content` does NOT unmount an inactive panel: bits-ui renders every
  // panel and marks the inactive ones `hidden`. So a bare
  // `<ProfileConversePosts />` inside the panel mounts on EVERY profile view
  // and its `onMount` fires `GET /api/comments/?author=...` -- a query that
  // runs a full `count()` over `comments_comment` with no supporting index --
  // for every visitor and every crawler hit on every profile, whether or not
  // anyone ever opens the tab. These latch on first open so the panel is
  // mounted lazily but is NOT torn down and refetched each time the visitor
  // tabs away and back.
  let ownerPostsOpened = false;
  let publicPostsOpened = false;
  $: if (ownerTab === "posts") ownerPostsOpened = true;
  $: if (publicTab === "posts") publicPostsOpened = true;

  let searchTimer: any;
  function handleSearch(e: Event) {
    const v = (e.target as HTMLInputElement).value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      updateParams({ search: v });
    }, 500);
  }

  function updateParams(updates: Record<string, string | null>) {
    const newUrl = new URL($page.url);
    Object.entries(updates).forEach(([key, value]) => {
      if (value) newUrl.searchParams.set(key, value);
      else newUrl.searchParams.delete(key);
    });
    newUrl.searchParams.set("page", "1");
    goto(newUrl, { reset: false });
  }

  function handlePageChange(newPage: number) {
    const newUrl = new URL($page.url);
    newUrl.searchParams.set("page", newPage.toString());
    goto(newUrl, { reset: false });
  }

  function buildImageUrl(image: any, preferOriginal = false) {
    if (!image?.url && !image?.thumbnail) return null;
    const imageUrl = preferOriginal
      ? image.url || image.thumbnail
      : image.thumbnail || image.url;
    if (/^https?:\/\//.test(imageUrl)) return imageUrl;
    return `${apiBase}${imageUrl.startsWith("/") ? "" : "/"}${imageUrl}`;
  }

  $: avatarUrl = buildImageUrl(creator.avatar_image);
  $: avatarFullSizeUrl = buildImageUrl(creator.avatar_image, true);
  $: bannerUrl = buildImageUrl(creator.banner_image);
  $: displayName = creator.full_name || creator.username;
  // Strip the leading social frontmatter block (issue ) before rendering,
  // and surface the parsed links as a tidy row above the bio.
  $: parsedBio = parseBioFrontmatter(creator.description || "");
  $: bioSocials = parsedBio.socials;
  // The bio's `::embed[]` cards  were resolved by the server loader as
  // THIS reader; seeding the page's resolver makes hydration render exactly
  // the server's markup. `request` resolves nothing the seed covers (and
  // everything, as this reader, after an identity change resets it).
  const firstPartyCards = useFirstPartyCards();
  $: firstPartyCards.seed(data.firstPartyCardSeed);
  // Primitives, so each statement re-runs only when ITS value changes: a
  // card landing elsewhere on the page re-renders nothing here (review F3).
  $: cardGeneration = $firstPartyCards.generation;
  $: firstPartyCards.request(parsedBio.body, undefined, cardGeneration);
  $: cardSignature = firstPartyCards.signature(
    parsedBio.body,
    $firstPartyCards,
  );
  $: descriptionHtml = processMarkdown(parsedBio.body, {
    firstPartyCards: firstPartyCards.cardsFor(parsedBio.body, cardSignature),
  });
  $: hasBio = Boolean(parsedBio.body.trim());
  $: seoDescription = compactText(
    parsedBio.body,
    $t("profile.metaDescription", "{name}'s creator profile on Free2Z.", {
      name: displayName,
    }),
  );
  $: profileImage = bannerUrl || avatarUrl || "/brand/free2z-og.png?v=2";
  // `sameAs` (issue ) only for the socials whose resolved URL actually
  // lands on that platform's own domain — see `sameAsUrls()` for why the
  // raw-URL frontmatter path can't be trusted wholesale (codex review on
  // ). Empty rather than omitted-key when there is nothing safe to
  // publish, cleaned up below.
  $: profileSameAs = sameAsUrls(bioSocials);
  // The subject of the ProfilePage. Handed to SeoHead as `mainEntity` (not as a
  // sibling `@graph` node) — Google requires ProfilePage.mainEntity and reports
  // its absence as a critical error in Search Console.
  $: profileJsonLd = {
    "@type": "Person",
    "@id": `${canonicalOrigin}/${encodeURIComponent(creator.username)}#creator`,
    name: displayName,
    alternateName: `@${creator.username}`,
    description: seoDescription,
    url: `${canonicalOrigin}/${encodeURIComponent(creator.username)}`,
    image: avatarUrl ? toAbsoluteUrl(avatarUrl, canonicalOrigin) : undefined,
    sameAs: profileSameAs.length ? profileSameAs : undefined,
  };

  function formatCount(value: number) {
    return value.toLocaleString($locale);
  }

  function articleCountLabel(value: number) {
    const count = formatCount(value);
    return isSingularCount(value, $locale)
      ? $t("profile.articleCountOne", "{count} article", { count })
      : $t("profile.articleCountMany", "{count} articles", { count });
  }

  function sortLabel(value: string) {
    if (value === "-published_at") {
      return $t("profile.sort.published", "Recently Published");
    }
    if (value === "-created_at") return $t("profile.sort.newest", "Newest");
    if (value === "created_at") return $t("profile.sort.oldest", "Oldest");
    if (value === "-f2z_score") return $t("profile.sort.popular", "Popular");
    return $t("profile.sort.label", "Sort by");
  }
</script>

<!--
  `modifiedTime` comes from a separate day-precision public-profile timestamp.
  It advances only when a public profile field actually changes.
  `Creator.updated_at` also moves for private security operations and must
  never back this public identity metadata.
-->
<SeoHead
  title={$t("profile.metaTitle", "{name} on Free2Z", { name: displayName })}
  description={seoDescription}
  path={`/${encodeURIComponent(creator.username)}`}
  type="profile"
  image={profileImage}
  imageAlt={$t("profile.ogImageAlt", "{name}'s Free2Z profile image", {
    name: displayName,
  })}
  mainEntity={profileJsonLd}
  dateCreated={creator.date_joined}
  modifiedTime={creator.date_modified || undefined}
/>

<main class="flex-1 bg-background pb-20 text-foreground">
  <!-- Banner -->
  <div class="relative h-72 w-full overflow-hidden bg-muted md:h-96">
    {#if bannerUrl}
      <img src={bannerUrl} alt="" class="h-full w-full object-cover" />
    {/if}
    <div
      class="absolute inset-0 bg-gradient-to-b from-transparent to-background/80"
    ></div>
  </div>

  <div class="relative z-10 container mx-auto -mt-12 max-w-6xl px-4">
    <!-- Profile Info -->
    <header class="flex flex-col items-end gap-6 pb-8 md:flex-row">
      <!-- Avatar -->
      <div class="relative mx-auto shrink-0 md:mx-0">
        <div
          class="h-24 w-24 overflow-hidden rounded-xl border-4 border-background bg-muted shadow-sm md:h-28 md:w-28"
        >
          {#if avatarUrl && avatarFullSizeUrl}
            <ImageLightbox
              thumbnailUrl={avatarUrl}
              fullSizeUrl={avatarFullSizeUrl}
              alt={displayName}
              triggerClass="h-full w-full"
            />
          {:else}
            <div
              class="flex h-full w-full items-center justify-center bg-muted text-2xl font-bold text-muted-foreground"
            >
              {displayName.slice(0, 2).toUpperCase()}
            </div>
          {/if}
        </div>
        {#if creator.is_verified}
          <Tooltip.Root>
            <Tooltip.Trigger class="absolute -right-1 -bottom-1">
              <div
                class="rounded-full border-2 border-background bg-primary p-0.5 text-primary-foreground"
              >
                <CheckCircle2 class="size-3.5" />
              </div>
            </Tooltip.Trigger>
            <Tooltip.Content>
              <p>{$t("profile.verifiedCreator", "Verified Creator")}</p>
            </Tooltip.Content>
          </Tooltip.Root>
        {/if}
      </div>

      <!-- Name & Actions -->
      <div
        class="mb-1 w-full min-w-0 flex-1 space-y-3 text-center md:text-left"
      >
        <div
          class="flex flex-col gap-4 md:flex-row md:items-end md:justify-between"
        >
          <div class="space-y-1.5">
            <h1
              class="truncate text-2xl font-bold tracking-tight sm:text-3xl"
              title={displayName}
            >
              {displayName}
            </h1>
            <div
              class="flex flex-wrap items-center justify-center gap-2 sm:gap-3 md:justify-start"
            >
              <span class="text-xs font-medium text-muted-foreground sm:text-sm"
                >@{creator.username}</span
              >
              <LiveIndicator username={creator.username} />
              <span class="text-xs text-muted-foreground sm:text-sm">
                {articleCountLabel(creator.zpages || 0)}
              </span>
            </div>
          </div>

          <!-- Action Buttons -->
          <div
            class={isOwner
              ? "grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:items-center sm:justify-center md:justify-end"
              : "flex w-full flex-nowrap items-center justify-center gap-1 sm:w-auto sm:gap-2 md:justify-end"}
          >
            <div
              class="order-2 min-w-0 grow-[9] basis-0 sm:order-1 sm:flex-none"
            >
              <ProfileDonate
                {creator}
                triggerClass={isOwner
                  ? ""
                  : "w-full gap-0.5 text-xs has-[>svg]:px-1 sm:w-auto sm:gap-2 sm:text-sm sm:has-[>svg]:px-3"}
              />
            </div>

            {#if !isOwner}
              <div
                class="order-1 min-w-0 grow-[11] basis-0 sm:order-2 sm:flex-none"
              >
                <ProfileSubscribe
                  {creator}
                  triggerClass="w-full gap-0.5 text-xs has-[>svg]:px-1 sm:w-auto sm:gap-2 sm:text-sm sm:has-[>svg]:px-3"
                />
              </div>
            {/if}

            <div class="order-3 shrink-0">
              <ProfileShare username={creator.username} {displayName} />
            </div>

            {#if !isOwner}
              <div class="order-4 shrink-0">
                {#key creator.username}
                  <ProfileModerationMenu username={creator.username} />
                {/key}
              </div>
            {/if}

            {#if isOwner}
              <Button
                href={`/${creator.username}/dashboard/profile`}
                variant="default"
              >
                <LayoutGrid class="mr-2 size-4" />
                {$t("profile.dashboard", "Dashboard")}
              </Button>
              <Button
                href={`/${creator.username}/dashboard/settings`}
                variant="outline"
              >
                <Settings class="mr-2 size-4" />
                {$t("auth.settings", "Settings")}
              </Button>
            {/if}
          </div>
        </div>
      </div>
    </header>

    {#if viewerBlocked}
      <p
        class="mx-auto mb-6 max-w-2xl rounded-lg border border-dashed border-border/60 px-4 py-3 text-center text-sm text-muted-foreground"
        role="status"
        data-testid="profile-blocked-banner"
      >
        {$t(
          "moderation.block.profileBanner",
          "You blocked @{username}. Their pages, comments and notifications are hidden from you. Use the ⋮ menu to unblock.",
          { username: creator.username },
        )}
      </p>
    {/if}

    <!-- Bio Section -->
    {#if bioSocials.length || hasBio}
      <div class="mx-auto max-w-2xl space-y-5 pb-8">
        {#if bioSocials.length}
          <SocialLinks links={bioSocials} />
        {/if}
        {#if hasBio}
          <div
            class="prose prose-sm max-w-none dark:prose-invert prose-a:text-primary prose-a:no-underline prose-a:hover:underline"
          >
            <MarkdownContent html={descriptionHtml} />
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Content Section -->
  <section class="container mx-auto max-w-6xl space-y-6 px-4 py-8">
    {#if isOwner}
      <!-- `ownerTab` exists so the ARTICLE pager below can be hidden on the
           Posts tab: Publications use the `?page=`-paginated article list,
           but Converse
           posts load by cursor from their own component. Left ungated, an
           owner with more than ten articles sees numbered article pagination
           under their posts, and clicking page 2 refetches articles and
           rewrites the URL while the posts on screen do not move. -->
      <Tabs.Root bind:value={ownerTab} class="w-full space-y-6">
        <div
          class="flex flex-col items-center justify-between gap-4 md:flex-row"
        >
          <Tabs.List>
            <Tabs.Trigger value="published">
              {$t("profile.published", "Publications")}
              <Badge variant="secondary" class="ml-2"
                >{formatCount(publishedCount)}</Badge
              >
            </Tabs.Trigger>
            <Tabs.Trigger value="posts" data-testid="profile-posts-tab">
              <MessagesSquare class="mr-1 size-3.5" />
              {$t("profile.postsTab", "Posts")}
            </Tabs.Trigger>
          </Tabs.List>

          <div
            class="flex w-full flex-col items-center gap-3 md:w-auto md:flex-row"
          >
            <!-- The article search / sort / tag controls drive the `?search=`
                 / `?ordering=` / `?tag=` ARTICLE query, and
                 ProfileConversePosts takes none of them -- so on the Posts tab
                 they read as controls over the posts on screen while operating
                 one reloads the articles behind the panel and leaves the posts
                 exactly where they were. Gated for the owner for the same
                 reason they are gated on the public view. The "New
                 Article" button below is NOT gated: it is a global action, not
                 a control over the list. -->
            {#if ownerTab !== "posts"}
              <div class="relative w-full md:w-48">
                <Search
                  class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  aria-label={$t(
                    "profile.searchArticlesLabel",
                    "Search {name}'s articles",
                    { name: displayName },
                  )}
                  placeholder={$t(
                    "profile.searchArticlesPlaceholder",
                    "Search articles",
                  )}
                  class="h-9 w-full pl-9"
                  value={currentSearch}
                  oninput={handleSearch}
                />
              </div>

              <Select.Root
                type="single"
                value={currentSort}
                onValueChange={(v) => updateParams({ ordering: v })}
              >
                <Select.Trigger class="h-9 w-full md:w-32">
                  <span class="truncate">
                    {sortLabel(currentSort)}
                  </span>
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="-published_at"
                    >{$t(
                      "profile.sort.published",
                      "Recently Published",
                    )}</Select.Item
                  >
                  <Select.Item value="-created_at"
                    >{$t("profile.sort.newest", "Newest")}</Select.Item
                  >
                  <Select.Item value="created_at"
                    >{$t("profile.sort.oldest", "Oldest")}</Select.Item
                  >
                  <Select.Item value="-f2z_score"
                    >{$t("profile.sort.popular", "Popular")}</Select.Item
                  >
                </Select.Content>
              </Select.Root>

              <TagFilter
                {availableTags}
                {currentTag}
                username={creator.username}
                mine={false}
                onSelect={(tag) => updateParams({ tag })}
              />
            {/if}

            <Button
              href="/edit"
              variant="outline"
              size="sm"
              class="hidden shrink-0 md:flex"
            >
              <PenLine class="mr-2 size-4" />
              {$t("profile.newArticle", "New Article")}
            </Button>
          </div>
        </div>

        <Tabs.Content
          value="published"
          class="mt-0 outline-none focus-visible:outline-none"
        >
          <div class="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {#each publishedPages as zpage}
              <ZpageCard story={zpage} compactOnMobile={true} />
            {:else}
              <div
                class="col-span-full flex flex-col items-center justify-center space-y-2 rounded-xl border-2 border-dashed py-16 text-center"
              >
                <FileText class="size-10 text-muted-foreground/20" />
                <p class="text-sm text-muted-foreground">
                  {$t("profile.noPublished", "No published articles found.")}
                </p>
                <Button href="/edit" variant="link" size="sm"
                  >{$t("profile.createArticle", "Create Article")}</Button
                >
              </div>
            {/each}
          </div>
        </Tabs.Content>

        <!-- The per-creator Converse surface. The `{#if}` is what
             makes it lazy: an inactive `Tabs.Content` is rendered-and-hidden,
             not unmounted, so without the guard this component mounts and
             fetches on every profile view. -->
        <Tabs.Content
          value="posts"
          class="mt-0 outline-none focus-visible:outline-none"
        >
          {#if ownerPostsOpened}
            <ProfileConversePosts username={creator.username} {displayName} />
          {/if}
        </Tabs.Content>

        {#if totalCount > 10 && ownerTab !== "posts"}
          <div class="mt-8 flex justify-center">
            <CustomPagination
              count={totalCount}
              perPage={10}
              {currentPage}
              onPageChange={handlePageChange}
            />
          </div>
        {/if}
      </Tabs.Root>
    {:else}
      <!-- Public View: Latest Articles and, since, this creator's
           Converse posts. Two tabs, same shape as the owner's. -->
      <!-- `publicTab` gates the ARTICLE controls below for the same reason
           `ownerTab` gates the owner's pager: search, sort and tag filter
           drive the `?search=` / `?ordering=` / `?tag=` article query, and
           ProfileConversePosts takes none of them. Left visible on the Posts
           tab they read as controls over the posts on screen, and operating
           one silently reloads the articles behind the panel while the posts
           do not move. -->
      <Tabs.Root bind:value={publicTab} class="w-full space-y-6">
        <div
          class="flex flex-col justify-between gap-4 border-b pb-6 md:flex-row md:items-end"
        >
          <div class="space-y-3">
            <Tabs.List>
              <Tabs.Trigger value="articles">
                <FileText class="mr-1 size-3.5" />
                {$t("profile.latestArticles", "Latest Articles")}
              </Tabs.Trigger>
              <Tabs.Trigger value="posts" data-testid="profile-posts-tab">
                <MessagesSquare class="mr-1 size-3.5" />
                {$t("profile.postsTab", "Posts")}
              </Tabs.Trigger>
            </Tabs.List>
            <p class="text-sm text-muted-foreground">
              {$t(
                "profile.latestArticlesDescription",
                "Explore thoughts and stories from {name}",
                { name: displayName },
              )}
            </p>
          </div>
          {#if publicTab !== "posts"}
            <div
              class="flex w-full flex-col items-center gap-3 md:w-auto md:flex-row"
            >
              <div class="relative w-full md:w-48">
                <Search
                  class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  aria-label={$t(
                    "profile.searchArticlesLabel",
                    "Search {name}'s articles",
                    { name: displayName },
                  )}
                  placeholder={$t(
                    "profile.searchArticlesPlaceholder",
                    "Search articles",
                  )}
                  class="h-9 w-full pl-9"
                  value={currentSearch}
                  oninput={handleSearch}
                />
              </div>

              <Select.Root
                type="single"
                value={currentSort}
                onValueChange={(v) => updateParams({ ordering: v })}
              >
                <Select.Trigger class="h-9 w-full md:w-32">
                  <span class="truncate">
                    {sortLabel(currentSort)}
                  </span>
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="-published_at"
                    >{$t(
                      "profile.sort.published",
                      "Recently Published",
                    )}</Select.Item
                  >
                  <Select.Item value="-created_at"
                    >{$t("profile.sort.newest", "Newest")}</Select.Item
                  >
                  <Select.Item value="created_at"
                    >{$t("profile.sort.oldest", "Oldest")}</Select.Item
                  >
                  <Select.Item value="-f2z_score"
                    >{$t("profile.sort.popular", "Popular")}</Select.Item
                  >
                </Select.Content>
              </Select.Root>

              <TagFilter
                {availableTags}
                {currentTag}
                username={creator.username}
                mine={false}
                onSelect={(tag) => updateParams({ tag })}
              />
            </div>
          {/if}
        </div>

        <Tabs.Content
          value="articles"
          class="mt-0 outline-none focus-visible:outline-none"
        >
          <div class="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {#each zpages as zpage}
              <ZpageCard story={zpage} compactOnMobile={true} />
            {:else}
              <div
                class="col-span-full flex flex-col items-center justify-center space-y-2 rounded-xl border-2 border-dashed py-16 text-center"
              >
                <FileText class="size-10 text-muted-foreground/20" />
                <p class="text-sm font-semibold">
                  {$t("profile.noArticles", "No articles yet")}
                </p>
                <p class="text-sm text-muted-foreground">
                  {$t(
                    "profile.noArticlesDescription",
                    "This creator hasn't published any stories yet.",
                  )}
                </p>
              </div>
            {/each}
          </div>

          {#if totalCount > 10}
            <div class="mt-8 flex justify-center">
              <CustomPagination
                count={totalCount}
                perPage={10}
                {currentPage}
                onPageChange={handlePageChange}
              />
            </div>
          {/if}
        </Tabs.Content>

        <!-- The per-creator Converse surface, lazily mounted for the
             same reason as the owner's panel above. -->
        <Tabs.Content
          value="posts"
          class="mt-0 outline-none focus-visible:outline-none"
        >
          {#if publicPostsOpened}
            <ProfileConversePosts username={creator.username} {displayName} />
          {/if}
        </Tabs.Content>
      </Tabs.Root>
    {/if}
  </section>
</main>
