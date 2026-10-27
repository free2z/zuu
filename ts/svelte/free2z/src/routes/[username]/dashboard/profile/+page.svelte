<script lang="ts">
  import type { PageData } from "./$types";
  import * as env from "$app/env/public";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card";
  import StatTile from "$lib/components/dashboard/StatTile.svelte";
  import MediaUploader from "$lib/components/media/MediaUploader.svelte";
  import MarkdownContent from "$lib/components/MarkdownContent.svelte";
  import SocialLinks from "$lib/components/profile/SocialLinks.svelte";
  import { processMarkdown } from "$lib/utils/markdown";
  import { useFirstPartyCards } from "$lib/first-party-card-resolver";
  import { parseBioFrontmatter } from "$lib/utils/bio";
  import { formatRelativeTime, toTimestamp } from "$lib/utils/date";
  import {
    FileText,
    Sparkles,
    Users,
    Star,
    Wallet,
    CheckCircle2,
    Edit3,
    Eye,
    UploadCloud,
    User,
    Check,
    Copy,
  } from "@lucide/svelte";
  import { isSingularCount, locale, tStore as t } from "$lib/i18n";
  import { formatTuzis, toFiniteNumber } from "$lib/utils/format-tuzis";
  import { currentUser, authStore } from "$lib/stores/auth";
  import { createAccountBalanceDisplay } from "$lib/account-balance";
  import { truncateZcashAddress } from "$lib/utils/zcashAddress";
  import { copyToClipboard } from "$lib/utils/clipboard";
  import { onDestroy } from "svelte";
  import { zpageCanonicalPath } from "$lib/zpage-path";

  export let data: PageData;

  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";

  $: creator = data.creator;
  const balanceDisplay = createAccountBalanceDisplay((owner) => {
    if (typeof window !== "undefined")
      authStore.observeAccountBalanceSnapshot(owner);
  });
  $: accountBalance = balanceDisplay(creator, $currentUser);
  $: zpages = data.zpages || [];
  let publishedPages: any[] = [];
  let drafts: any[] = [];
  let sortedDrafts: any[] = [];

  $: {
    const pub = [];
    const dr = [];
    for (const page of zpages) {
      if (page.is_published) {
        pub.push(page);
      } else {
        dr.push(page);
      }
    }
    publishedPages = pub;
    drafts = dr;
    sortedDrafts = [...dr].sort(
      (a, b) => toTimestamp(b.updated_at) - toTimestamp(a.updated_at),
    );
  }

  // `zpages` is a single DRF page (PAGE_SIZE=12), so the array length silently
  // caps at 12. The `?mine=true` list ships the real totals; fall back to the
  // array only when the API did not send them.
  $: publishedCount =
    typeof data.publishedCount === "number"
      ? data.publishedCount
      : publishedPages.length;
  $: draftCount =
    typeof data.draftCount === "number" ? data.draftCount : drafts.length;

  // How many the count promises that this card cannot actually render. The two
  // numbers come from different places — the totals span the whole queryset,
  // the lists are one 12-row page ordered `-created_at` — so a card can
  // advertise 1,234 drafts and have none to show. Whenever that gap is
  // non-zero the card offers a way out to the full, paginated list.
  $: hiddenDrafts = Math.max(0, draftCount - drafts.length);
  $: hiddenPublished = Math.max(0, publishedCount - publishedPages.length);
  $: allPagesUrl = `/${creator.username}/dashboard/pages`;

  $: displayName = creator.full_name || creator.username;

  function buildImageUrl(image: any) {
    if (!image?.url && !image?.thumbnail) return null;
    const imageUrl = image.thumbnail || image.url;
    if (/^https?:\/\//.test(imageUrl)) return imageUrl;
    return `${apiBase}${imageUrl.startsWith("/") ? "" : "/"}${imageUrl}`;
  }

  function pageUrl(page: any) {
    const canonicalPath = zpageCanonicalPath(page || {});
    if (canonicalPath) return canonicalPath;
    if (page?.get_url) return page.get_url;
    return `/article/${page.free2zaddr}`;
  }

  $: avatarUrl = buildImageUrl(creator.avatar_image);
  $: bannerUrl = buildImageUrl(creator.banner_image);
  $: parsedBio = parseBioFrontmatter(creator.description || "");
  // The owner's bio as the profile shows it, `::embed[]` cards included
  //resolved in the browser by the page's resolver, as the viewer —
  // who is the owner here. The server render is the neutral card; hydration
  // matches it, and the cards follow.
  const firstPartyCards = useFirstPartyCards();
  // Primitives, so each statement re-runs only when ITS value changes: a
  // card landing elsewhere on the page re-renders nothing here (review F3).
  $: cardGeneration = $firstPartyCards.generation;
  $: firstPartyCards.request(parsedBio.body, undefined, cardGeneration);
  $: cardSignature = firstPartyCards.signature(
    parsedBio.body,
    $firstPartyCards,
  );
  $: bioHtml = processMarkdown(parsedBio.body, {
    firstPartyCards: firstPartyCards.cardsFor(parsedBio.body, cardSignature),
  });

  // DRF hands decimals back as STRINGS, and `String.prototype.toLocaleString`
  // is a no-op that returns the string unchanged — so the old
  // `value.toLocaleString($locale)` silently printed raw payloads like
  // "3.45372709". The balance formatter lives in `$lib/utils/format-tuzis`,
  // shared with the billing page: two copies of it is how the billing page
  // kept the no-op for another dozen releases, and how the profile
  // copy's `Number()` round-trip went unnoticed.

  /** Whole-number counts: grouped, never fractional. */
  function formatCount(value: string | number | null | undefined) {
    const parsed = toFiniteNumber(value);
    if (parsed === null) return "—";
    return new Intl.NumberFormat($locale, {
      useGrouping: true,
      maximumFractionDigits: 0,
    }).format(parsed);
  }

  function draftsInProgressLabel(value: number) {
    const count = formatCount(value);
    return isSingularCount(value, $locale)
      ? $t("dashboard.profile.draftCountOne", "{count} work in progress", {
          count,
        })
      : $t("dashboard.profile.draftCountMany", "{count} works in progress", {
          count,
        });
  }

  function livePagesLabel(value: number) {
    const count = formatCount(value);
    return isSingularCount(value, $locale)
      ? $t("dashboard.profile.livePageCountOne", "{count} live page", { count })
      : $t("dashboard.profile.livePageCountMany", "{count} live pages", {
          count,
        });
  }

  // The wallet chip cannot fit a Unified address, so it middle-truncates. The
  // full value stays reachable through `title` AND the copy button — a tooltip
  // alone is unreachable on touch, and the tail is the checksum-bearing part
  // the creator actually verifies.
  $: truncatedAddress = truncateZcashAddress(creator.p2paddr);

  let addressCopyState: "idle" | "copied" | "failed" = "idle";
  let addressCopyTimer: ReturnType<typeof setTimeout> | undefined;

  async function copyAddress() {
    clearTimeout(addressCopyTimer);
    const ok = await copyToClipboard(creator.p2paddr);
    addressCopyState = ok ? "copied" : "failed";
    addressCopyTimer = setTimeout(() => (addressCopyState = "idle"), 2000);
  }

  onDestroy(() => clearTimeout(addressCopyTimer));

  // The stat-tile geometry lives in `$lib/components/dashboard/StatTile.svelte`
  // now, shared with the billing page. It is documented there; the short of it
  // is that the icon stacks above the text below `sm` so the label gets the
  // tile's full inner width, and no UI copy is ever truncated or broken
  // mid-word to buy that width back.
</script>

<svelte:head>
  <title
    >{$t("dashboard.profile.metaTitle", "{name} • Profile Dashboard", {
      name: displayName,
    })}</title
  >
  <meta
    name="description"
    content={$t(
      "dashboard.profile.metaDescription",
      "Manage {name}'s profile, pages, and creator stats.",
      {
        name: displayName,
      },
    )}
  />
</svelte:head>

<main class="flex-1 bg-background pb-20 text-foreground">
  <!-- Banner -->
  <div class="relative h-48 w-full overflow-hidden bg-muted md:h-56">
    {#if bannerUrl}
      <img
        src={bannerUrl}
        alt={$t("profile.bannerAlt", "Profile banner")}
        class="h-full w-full object-cover"
      />
    {/if}
    <div
      class="absolute inset-0 bg-gradient-to-b from-transparent to-background/80"
    ></div>
  </div>

  <!--
    Issue: the negative margin that lets the avatar peek over the banner
    belongs to the avatar/name column, NOT to the whole container. On the
    container it dragged the right-hand button group up onto the banner art,
    where it had no contrast backing and read as misaligned.
  -->
  <div class="relative z-10 container mx-auto max-w-6xl space-y-8 px-4">
    <header
      class="flex flex-col justify-between gap-4 md:flex-row md:items-end"
    >
      <div class="-mt-12 flex min-w-0 items-end gap-4">
        <!-- Avatar -->
        <div class="relative shrink-0">
          <div
            class="h-20 w-20 overflow-hidden rounded-xl border-4 border-background bg-muted shadow-sm"
          >
            {#if avatarUrl}
              <img
                src={avatarUrl}
                alt={displayName}
                class="h-full w-full object-cover"
              />
            {:else}
              <div
                class="flex h-full w-full items-center justify-center bg-muted text-lg font-bold text-muted-foreground"
              >
                {displayName.slice(0, 2).toUpperCase()}
              </div>
            {/if}
          </div>
          {#if creator.is_verified}
            <div
              class="absolute -right-1 -bottom-1 rounded-full border-2 border-background bg-primary p-0.5 text-primary-foreground"
              title={$t("profile.verifiedCreator", "Verified Creator")}
            >
              <CheckCircle2 class="size-3.5" />
            </div>
          {/if}
        </div>

        <!--
          `full_name` is up to 128 chars and may be one unbroken token, which
          overflowed the container with nothing to break on.
        -->
        <div class="mb-1 min-w-0 space-y-1">
          <div class="flex min-w-0 items-center gap-2">
            <h1
              class="min-w-0 truncate text-3xl font-bold tracking-tight"
              title={displayName}
            >
              {displayName}
            </h1>
            {#if creator.is_verified}
              <Badge
                variant="secondary"
                class="shrink-0 border-transparent bg-blue-100 text-blue-600 hover:bg-blue-100/80 dark:bg-blue-900/30 dark:text-blue-400"
              >
                {$t("creators.filters.verified", "Verified")}
              </Badge>
            {/if}
          </div>
          <p class="truncate text-muted-foreground">@{creator.username}</p>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <Button href={`/${creator.username}`} variant="outline">
          <Eye class="mr-2 size-4" />
          {$t("dashboard.profile.publicView", "Public View")}
        </Button>
        <Button href={`/${creator.username}/dashboard/settings`}>
          <User class="mr-2 size-4" />
          {$t("dashboard.profile.editProfile", "Edit Profile")}
        </Button>
      </div>
    </header>

    <!--
      Every tile is a link: the owner asked why the stats were not clickable,
      and "I have 3 drafts but where are they?" — Drafts jumps to the section
      further down the same page.
    -->
    <section class="grid grid-cols-2 gap-4 md:grid-cols-4">
      <StatTile
        href={allPagesUrl}
        testId="stat-published"
        value={formatCount(publishedCount)}
        label={$t("dashboard.pages.published", "Published pages")}
      >
        <FileText slot="icon" class="size-5 text-primary" />
      </StatTile>

      <StatTile
        href="#drafts"
        testId="stat-drafts"
        value={formatCount(draftCount)}
        label={$t("profile.drafts", "Drafts")}
      >
        <Edit3 slot="icon" class="size-5 text-primary" />
      </StatTile>

      <!--
        `creator.tuzis` — the spendable 2Z credit balance, the same field the
        billing page shows. NOT `creator.total`, which `Creator.cache_total()`
        computes as `Sum(zpage.total) + tuzi_total / 1000`: a ZEC-equivalent
        page-support cache that is neither 2Z nor earnings.

        Balance and Fans both span the full row on mobile. Both, not one: 4
        tiles where one spans is 5 cells, which leaves a visible hole beside
        Fans. With both spanning it is 6 —
        `[Published | Drafts]`, `[Balance]`, `[Fans]`.
      -->
      <StatTile
        href={`/${creator.username}/dashboard/billing`}
        testId="stat-balance"
        wide
        value={formatTuzis(accountBalance, $locale)}
        label={$t("dashboard.profile.balance2Z", "2Z Balance")}
      >
        <Sparkles slot="icon" class="size-5 text-primary" />
      </StatTile>

      <!-- There is no /fans route; subscribers live on the billing page. -->
      <StatTile
        href={`/${creator.username}/dashboard/billing?section=subscribers`}
        testId="stat-fans"
        wide
        value={formatCount(creator.fans_count || 0)}
        label={$t("dashboard.profile.fans", "Fans")}
      >
        <Users slot="icon" class="size-5 text-primary" />
      </StatTile>
    </section>

    <!--
      Drafts/Published come FIRST in the DOM so that on one mobile column you
      are not scrolling past Quick Actions, a full-size upload dropzone and the
      bio to reach them. `lg:order-*` puts the sidebar back on the left at
      desktop, where the two-column layout is unchanged.

      Deliberately a DOM reorder and not a mobile-only `order-*` swap: `order`
      is CSS-only, so keyboard focus order and screen-reader reading order
      would still follow the source and land in Quick Actions first, painting
      focus BELOW the drafts it visually precedes (WCAG 2.4.3 Focus Order).
    -->
    <div class="grid grid-cols-1 gap-8 lg:grid-cols-3">
      <!-- Content: Drafts & Published (right-hand column at lg:) -->
      <div
        class="space-y-6 lg:order-2 lg:col-span-2"
        data-testid="dashboard-content"
      >
        <!-- Drafts Section -->
        <Card id="drafts" class="scroll-mt-24">
          <CardHeader
            class="flex flex-row items-center justify-between space-y-0"
          >
            <div class="space-y-1">
              <CardTitle class="flex items-center gap-2">
                <Edit3 class="size-5" />
                {$t("profile.drafts", "Drafts")}
              </CardTitle>
              <CardDescription
                >{draftsInProgressLabel(draftCount)}</CardDescription
              >
            </div>
            {#if hiddenDrafts > 0}
              <Button
                href={allPagesUrl}
                variant="outline"
                size="sm"
                class="shrink-0"
                data-testid="drafts-view-all"
              >
                {$t("dashboard.profile.viewAll", "View all")}
              </Button>
            {/if}
          </CardHeader>
          <CardContent class="space-y-3">
            {#if sortedDrafts.length > 0}
              {#each sortedDrafts as draft (draft.free2zaddr)}
                <div
                  class="group space-y-2 rounded-xl border bg-card p-4 transition-colors hover:border-primary/50"
                >
                  <!--
                    NO `items-start`. This one word is what made the page scroll
                    415px sideways on a phone: `align-items: flex-start` on a
                    COLUMN flex container sizes children to fit-content on the
                    CROSS (horizontal) axis, and a fit-content box whose
                    min-content is wider than the space available takes the
                    min-content width. The title below is nowrap, so its
                    min-content width IS the whole title — the inner column
                    measured 479px inside a 254px parent. `min-w-0` and `flex-1`
                    are powerless against that: they govern the vertical main
                    axis. Default `stretch` gives the child the container's
                    width, which is the entire fix (measured: 801px → 386px).
                    `sm:items-center` still centres the desktop row.
                  -->
                  <div
                    class="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"
                  >
                    <div class="min-w-0 flex-1 space-y-1">
                      <div class="flex items-center gap-2">
                        <Badge
                          variant="secondary"
                          class="text-[10px] tracking-wide uppercase"
                          >{$t("dashboard.pages.draft", "Draft")}</Badge
                        >
                        <span class="text-xs text-muted-foreground"
                          >{$t(
                            "dashboard.profile.modified",
                            "Modified {time}",
                            {
                              time: formatRelativeTime(
                                draft.updated_at,
                                $locale,
                              ),
                            },
                          )}</span
                        >
                      </div>
                      <!--
                        `truncate` here was `white-space: nowrap`, which is what
                        made the title unshrinkable in the first place. Titles
                        are user-authored content, so they may wrap and clamp:
                        two lines, then an ellipsis only for genuinely long
                        ones. (UI copy, by contrast, never truncates at all.)
                        `break-words` covers the one-unbroken-token title.
                      -->
                      <h3
                        class="line-clamp-2 pr-4 text-base font-semibold break-words text-foreground"
                        title={draft.title || $t("editor.untitled", "Untitled")}
                      >
                        {draft.title || $t("editor.untitled", "Untitled")}
                      </h3>
                      <p class="line-clamp-1 text-sm text-muted-foreground">
                        {draft.description ||
                          $t(
                            "dashboard.profile.noDescriptionYet",
                            "No description provided yet.",
                          )}
                      </p>
                    </div>
                    <Button
                      href={`/edit?id=${encodeURIComponent(draft.free2zaddr)}`}
                      size="sm"
                    >
                      {$t("profile.continueWriting", "Continue Writing")}
                    </Button>
                  </div>
                </div>
              {/each}
            {:else}
              <div
                class="flex flex-col items-center justify-center space-y-2 rounded-xl border-2 border-dashed py-12 text-center"
              >
                <Edit3 class="size-10 text-muted-foreground/20" />
                {#if draftCount > 0}
                  <!--
                    The list is one 12-row page ordered `-created_at`, but the
                    count is the whole-queryset total. A creator whose 12 newest
                    pages are all published has drafts that this card simply
                    cannot show — saying "No active drafts" under a heading that
                    just claimed there are some is the worst possible answer to
                    "where are my drafts?".
                  -->
                  <p
                    class="max-w-md text-sm text-muted-foreground"
                    data-testid="drafts-elsewhere"
                  >
                    {$t(
                      "dashboard.profile.draftsNotRecent",
                      "None of your most recently created pages are drafts, so there are none to show here.",
                    )}
                  </p>
                  <Button href={allPagesUrl} variant="link" size="sm"
                    >{$t(
                      "dashboard.profile.viewAllDrafts",
                      "View all your drafts",
                    )}</Button
                  >
                {:else}
                  <p class="text-sm text-muted-foreground">
                    {$t(
                      "dashboard.profile.noActiveDrafts",
                      "No active drafts.",
                    )}
                  </p>
                  <Button href="/edit" variant="link" size="sm"
                    >{$t(
                      "dashboard.profile.createPage",
                      "Create a new page",
                    )}</Button
                  >
                {/if}
              </div>
            {/if}
          </CardContent>
        </Card>

        <!-- Published Section -->
        <Card>
          <CardHeader
            class="flex flex-row items-center justify-between space-y-0"
          >
            <div class="space-y-1">
              <CardTitle class="flex items-center gap-2">
                <CheckCircle2 class="size-5" />
                {$t("dashboard.pages.published", "Published pages")}
              </CardTitle>
              <CardDescription>{livePagesLabel(publishedCount)}</CardDescription
              >
            </div>
            {#if hiddenPublished > 0}
              <Button
                href={allPagesUrl}
                variant="outline"
                size="sm"
                class="shrink-0"
                data-testid="published-view-all"
              >
                {$t("dashboard.profile.viewAll", "View all")}
              </Button>
            {/if}
          </CardHeader>
          <CardContent class="space-y-3">
            {#if publishedPages.length > 0}
              {#each publishedPages as page (page.free2zaddr)}
                <div
                  class="group space-y-2 rounded-xl border bg-card p-4 transition-colors hover:border-primary/50"
                >
                  <!-- Same `items-start` trap as the drafts row; see above. -->
                  <div
                    class="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"
                  >
                    <div class="min-w-0 flex-1 space-y-1">
                      <div class="flex items-center gap-2">
                        <Badge
                          variant="default"
                          class="text-[10px] tracking-wide uppercase"
                          >{$t(
                            "dashboard.pages.publishedBadge",
                            "Published",
                          )}</Badge
                        >
                        <span class="text-xs text-muted-foreground"
                          >{formatRelativeTime(page.updated_at, $locale)}</span
                        >
                      </div>
                      <h3
                        class="line-clamp-2 pr-4 text-base font-semibold break-words text-foreground"
                        title={page.title}
                      >
                        <a
                          href={pageUrl(page)}
                          class="transition-colors hover:text-primary hover:underline"
                          >{page.title}</a
                        >
                      </h3>
                      <p class="line-clamp-1 text-sm text-muted-foreground">
                        {page.description ||
                          $t(
                            "dashboard.profile.noDescription",
                            "No description provided.",
                          )}
                      </p>
                      {#if page.tags?.length}
                        <div class="flex flex-wrap gap-1.5 pt-1">
                          {#each page.tags.slice(0, 3) as tag}
                            <Badge variant="outline" class="text-[10px]"
                              >#{tag}</Badge
                            >
                          {/each}
                        </div>
                      {/if}
                    </div>
                    <div class="flex shrink-0 gap-2">
                      <Button
                        href={`/edit?id=${encodeURIComponent(page.free2zaddr)}`}
                        size="sm"
                        variant="default"
                      >
                        <Edit3 class="mr-1.5 size-3.5" />
                        {$t("dashboard.pages.edit", "Edit")}
                      </Button>
                      <Button href={pageUrl(page)} size="sm" variant="outline">
                        <Eye class="mr-1.5 size-3.5" />
                        {$t("dashboard.pages.view", "View")}
                      </Button>
                    </div>
                  </div>
                </div>
              {/each}
            {:else}
              <div
                class="flex flex-col items-center justify-center space-y-2 rounded-xl border-2 border-dashed py-12 text-center"
              >
                <FileText class="size-10 text-muted-foreground/20" />
                {#if publishedCount > 0}
                  <!-- Same trap as the drafts card, mirrored. -->
                  <p
                    class="max-w-md text-sm text-muted-foreground"
                    data-testid="published-elsewhere"
                  >
                    {$t(
                      "dashboard.profile.publishedNotRecent",
                      "None of your most recently created pages are published, so there are none to show here.",
                    )}
                  </p>
                  <Button href={allPagesUrl} variant="link" size="sm"
                    >{$t(
                      "dashboard.profile.viewAllPages",
                      "View all your pages",
                    )}</Button
                  >
                {:else}
                  <p class="text-sm text-muted-foreground">
                    {$t(
                      "dashboard.profile.nothingPublished",
                      "Nothing published yet.",
                    )}
                  </p>
                  <Button href="/edit" variant="link" size="sm"
                    >{$t(
                      "dashboard.profile.createFirstPage",
                      "Create your first page",
                    )}</Button
                  >
                {/if}
              </div>
            {/if}
          </CardContent>
        </Card>
      </div>

      <!-- Sidebar: Quick Actions & About (left-hand column at lg:) -->
      <div class="space-y-6 lg:order-1" data-testid="dashboard-sidebar">
        <!-- Quick Actions -->
        <Card>
          <CardHeader>
            <CardTitle class="text-base"
              >{$t(
                "dashboard.profile.quickActions",
                "Quick Actions",
              )}</CardTitle
            >
          </CardHeader>
          <CardContent class="space-y-2">
            <Button href="/edit" class="w-full justify-start" variant="default">
              <Edit3 class="mr-2 size-4" />
              {$t("dashboard.profile.createArticle", "Create New Article")}
            </Button>
            <Button
              href={`/${creator.username}/dashboard/stream`}
              variant="outline"
              class="w-full justify-start"
            >
              <Users class="mr-2 size-4" />
              {$t("dashboard.profile.startStream", "Start Live Stream")}
            </Button>
            <Button
              href={`/${creator.username}/dashboard/media`}
              variant="outline"
              class="w-full justify-start"
            >
              <UploadCloud class="mr-2 size-4" />
              {$t("dashboard.profile.uploadMedia", "Manage Uploads")}
            </Button>
          </CardContent>
        </Card>

        <!-- Quick Upload -->
        <Card>
          <CardHeader>
            <CardTitle class="text-base"
              >{$t("dashboard.profile.quickUpload", "Quick Upload")}</CardTitle
            >
          </CardHeader>
          <CardContent>
            <MediaUploader />
          </CardContent>
        </Card>

        <!-- About Card -->
        <Card>
          <CardHeader>
            <CardTitle class="text-base"
              >{$t("dashboard.profile.creatorBio", "Creator Bio")}</CardTitle
            >
          </CardHeader>
          <CardContent class="space-y-4">
            {#if parsedBio.socials.length}
              <SocialLinks links={parsedBio.socials} />
            {/if}
            {#if parsedBio.body.trim()}
              <div
                class="prose prose-sm max-w-none text-muted-foreground dark:prose-invert"
              >
                <MarkdownContent html={bioHtml} />
              </div>
            {:else}
              <p class="text-sm leading-relaxed text-muted-foreground">
                {$t(
                  "dashboard.profile.bioFallback",
                  "Add a bio to tell supporters what you are creating.",
                )}
              </p>
            {/if}

            <div class="space-y-3 border-t pt-4">
              <div class="flex items-center justify-between gap-2">
                <span
                  class="flex shrink-0 items-center text-xs font-medium text-muted-foreground"
                >
                  <Wallet class="mr-2 size-4 text-primary" />
                  {$t("dashboard.profile.zcashWallet", "Zcash Wallet")}
                </span>
                {#if creator.p2paddr}
                  <!--
                    Middle-truncated, tail kept: `max-w-[140px] truncate` was
                    CSS ellipsis, which by definition cuts the tail — and the
                    tail is the checksum-bearing part a vanity-prefix attacker
                    cannot cheaply fake. The copy button is not decoration: a
                    `title` tooltip is unreachable on touch, so without it the
                    full address would be unobtainable on a phone.
                  -->
                  <button
                    type="button"
                    onclick={copyAddress}
                    title={creator.p2paddr}
                    aria-label={$t(
                      "dashboard.profile.copyZcashWallet",
                      "Copy Zcash address",
                    )}
                    class="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md border bg-muted px-2 py-1 font-mono text-xs text-foreground transition-colors outline-none hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    <span class="truncate">{truncatedAddress}</span>
                    {#if addressCopyState === "copied"}
                      <Check class="size-3.5 shrink-0 text-emerald-500" />
                    {:else}
                      <Copy class="size-3.5 shrink-0 text-muted-foreground" />
                    {/if}
                  </button>
                  <p class="sr-only" role="status" aria-live="polite">
                    {#if addressCopyState === "copied"}
                      {$t("common.copied", "Copied!")}
                    {:else if addressCopyState === "failed"}
                      {$t("common.copyFailed", "Copy failed")}
                    {/if}
                  </p>
                {:else}
                  <Badge variant="secondary"
                    >{$t(
                      "dashboard.profile.notConfigured",
                      "Not Configured",
                    )}</Badge
                  >
                {/if}
              </div>
              <div class="flex items-center justify-between">
                <span
                  class="flex items-center text-xs font-medium text-muted-foreground"
                >
                  <Star class="mr-2 size-4 text-primary" />
                  {$t("dashboard.profile.membership", "Membership")}
                </span>
                <span class="text-sm font-semibold">
                  {Number(creator.member_price) > 0
                    ? $t("dashboard.profile.monthlyPrice", "{price} 2Z/month", {
                        price: Number(creator.member_price).toLocaleString(
                          $locale,
                        ),
                      })
                    : $t("creators.filters.free", "Free")}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  </div>
</main>
