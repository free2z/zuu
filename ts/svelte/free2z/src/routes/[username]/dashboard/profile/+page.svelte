<script lang="ts">
  import type { PageData } from "./$types";
  import { env } from "$env/dynamic/public";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card";
  import MediaUploader from "$lib/components/media/MediaUploader.svelte";
  import MarkdownContent from "$lib/components/MarkdownContent.svelte";
  import SocialLinks from "$lib/components/profile/SocialLinks.svelte";
  import { formatRelativeTime } from "$lib/utils/date";
  import { processMarkdown } from "$lib/utils/markdown";
  import { parseBioFrontmatter } from "$lib/utils/bio";
  import { truncateZcashAddress } from "$lib/utils/zcashAddress";
  import { copyToClipboard } from "$lib/utils/clipboard";
  import { onDestroy } from "svelte";
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

  export let data: PageData;

  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";

  $: creator = data.creator;
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
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );
  }

  // `zpages` is a single DRF page (PAGE_SIZE=12), so the array length silently
  // caps the stats at 12. The `?mine=true` list ships whole-queryset
  // `published_count`/`draft_count` alongside the 12-row page; fall back to the
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
    if (page?.get_url) return page.get_url;
    if (page?.vanity) return `/${creator.username}/${page.vanity}`;
    return `/article/${page.free2zaddr}`;
  }

  $: avatarUrl = buildImageUrl(creator.avatar_image);
  $: bannerUrl = buildImageUrl(creator.banner_image);
  $: parsedBio = parseBioFrontmatter(creator.description || "");
  $: bioHtml = processMarkdown(parsedBio.body);

  // DRF hands decimals back as STRINGS, and `String.prototype.toLocaleString`
  // is a no-op that returns the string unchanged — so formatting a raw payload
  // silently prints it verbatim, e.g. "3.45372709". Coerce first, then format
  // for real.
  function toFiniteNumber(value: unknown): number | null {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /** Whole-number counts: grouped, never fractional. */
  function formatCount(value: string | number | null | undefined) {
    const parsed = toFiniteNumber(value);
    if (parsed === null) return "—";
    return new Intl.NumberFormat(undefined, {
      useGrouping: true,
      maximumFractionDigits: 0,
    }).format(parsed);
  }

  /**
   * Drop everything past 2 decimals by TRUNCATING toward zero, working on the
   * decimal text so no binary-float error creeps in.
   *
   * Never round a balance up. `tuzis` carries 3 decimal places, so a plain
   * `maximumFractionDigits: 2` renders 4.996 as "5" — a balance that claims
   * more than the creator has, sitting next to actions priced at 5 that will
   * then fail. `Math.trunc(n * 100) / 100` is not a fix either: it overflows
   * 2^53 and turns 99999999999999.999 into 100000000000000, overstating by the
   * largest possible margin exactly where precision matters most.
   */
  function truncateToCents(raw: string | number, fallback: number): number {
    const text = typeof raw === "number" ? String(raw) : raw.trim();
    const match = /^([+-]?\d*)(?:\.(\d*))?$/.exec(text);
    if (!match) return fallback;
    const whole = match[1] || "0";
    const cents = (match[2] || "").slice(0, 2);
    const parsed = Number(cents ? `${whole}.${cents}` : whole);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  /**
   * 2Z credits carry 3 decimal places, but three decimals of trailing zeros is
   * noise in a stat tile. Grouping on, at most 2 decimals, no padding — so
   * "3454.000" reads as "3,454" and "64672.234" as "64,672.23".
   */
  function formatTuzis(value: string | number | null | undefined) {
    const parsed = toFiniteNumber(value);
    if (parsed === null) return "—";
    return new Intl.NumberFormat(undefined, {
      useGrouping: true,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(truncateToCents(value as string | number, parsed));
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

  // `min-w-0` on the anchor is load-bearing: it is the grid item, and a grid
  // item defaults to `min-width: auto`, which refuses to shrink below its
  // content's min-content width. The 2Z tile rendered a raw multi-decimal
  // string at `text-2xl`, so at `grid-cols-2` the row demanded more than a
  // phone is wide and the whole document scrolled sideways.
  const STAT_CARD_LINK =
    "group/stat block min-w-0 rounded-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";
  const STAT_CARD =
    "h-full min-w-0 transition-colors group-hover/stat:border-primary/50 group-focus-visible/stat:border-primary/50";
</script>

<svelte:head>
  <title>{displayName} • Profile Dashboard</title>
  <meta
    name="description"
    content={`Manage ${displayName}'s profile, pages, and creator stats.`}
  />
</svelte:head>

<main class="flex-1 bg-background pb-20 text-foreground">
  <!-- Banner -->
  <div class="relative h-48 w-full overflow-hidden bg-muted md:h-56">
    {#if bannerUrl}
      <img src={bannerUrl} alt="Banner" class="h-full w-full object-cover" />
    {/if}
    <div
      class="absolute inset-0 bg-gradient-to-b from-transparent to-background/80"
    ></div>
  </div>

  <div class="relative z-10 container mx-auto -mt-12 max-w-6xl space-y-8 px-4">
    <header
      class="flex flex-col justify-between gap-4 md:flex-row md:items-end"
    >
      <div class="flex min-w-0 items-end gap-4">
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
              title="Verified Creator"
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
                Verified
              </Badge>
            {/if}
          </div>
          <p class="truncate text-muted-foreground">@{creator.username}</p>
        </div>
      </div>

      <div class="mb-1 flex flex-wrap items-center gap-2">
        <Button href={`/${creator.username}`} variant="outline">
          <Eye class="mr-2 size-4" /> Public View
        </Button>
        <Button href={`/${creator.username}/dashboard/settings`}>
          <User class="mr-2 size-4" /> Edit Profile
        </Button>
      </div>
    </header>

    <!--
      Stats. Every tile is a link — they were inert `<div>`s with no href and no
      affordance, and "I have 3 drafts but where are they?" had no answer.
      Drafts jumps to the section further down the same page.
    -->
    <section class="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <a href={allPagesUrl} class={STAT_CARD_LINK} data-testid="stat-published">
        <Card class={STAT_CARD}>
          <CardContent
            class="flex flex-col items-start gap-2 p-4 sm:flex-row sm:items-center sm:gap-3"
          >
            <div class="shrink-0 rounded-full bg-primary/10 p-2.5">
              <FileText class="size-5 text-primary" />
            </div>
            <div class="min-w-0">
              <p
                class="text-xl font-bold tabular-nums sm:text-2xl"
                title={formatCount(publishedCount)}
              >
                {formatCount(publishedCount)}
              </p>
              <p
                class="text-xs font-medium tracking-wider text-muted-foreground uppercase"
              >
                Published
              </p>
            </div>
          </CardContent>
        </Card>
      </a>

      <a href="#drafts" class={STAT_CARD_LINK} data-testid="stat-drafts">
        <Card class={STAT_CARD}>
          <CardContent
            class="flex flex-col items-start gap-2 p-4 sm:flex-row sm:items-center sm:gap-3"
          >
            <div class="shrink-0 rounded-full bg-primary/10 p-2.5">
              <Edit3 class="size-5 text-primary" />
            </div>
            <div class="min-w-0">
              <p
                class="text-xl font-bold tabular-nums sm:text-2xl"
                title={formatCount(draftCount)}
              >
                {formatCount(draftCount)}
              </p>
              <p
                class="text-xs font-medium tracking-wider text-muted-foreground uppercase"
              >
                Drafts
              </p>
            </div>
          </CardContent>
        </Card>
      </a>

      <!--
        `creator.tuzis` — the spendable 2Z credit balance, the same field the
        billing page shows. NOT `creator.total`, which is a ZEC-equivalent
        page-support cache, not a 2Z balance: labelling it "2Zs Earned" was
        wrong on both the quantity and the unit.
      -->
      <a
        href={`/${creator.username}/dashboard/billing`}
        class={`${STAT_CARD_LINK} col-span-2 sm:col-span-1`}
        data-testid="stat-balance"
      >
        <Card class={STAT_CARD}>
          <CardContent
            class="flex flex-col items-start gap-2 p-4 sm:flex-row sm:items-center sm:gap-3"
          >
            <div class="shrink-0 rounded-full bg-primary/10 p-2.5">
              <Sparkles class="size-5 text-primary" />
            </div>
            <div class="min-w-0">
              <p
                class="text-xl font-bold tabular-nums sm:text-2xl"
                title={formatTuzis(creator.tuzis)}
              >
                {formatTuzis(creator.tuzis)}
              </p>
              <p
                class="text-xs font-medium tracking-wider text-muted-foreground uppercase"
              >
                2Z Balance
              </p>
            </div>
          </CardContent>
        </Card>
      </a>

      <!-- There is no /fans route; subscribers live on the billing page, which
           reads `?section=subscribers` off the URL and selects that tab. -->
      <a
        href={`/${creator.username}/dashboard/billing?section=subscribers`}
        class={`${STAT_CARD_LINK} col-span-2 sm:col-span-1`}
        data-testid="stat-fans"
      >
        <Card class={STAT_CARD}>
          <CardContent
            class="flex flex-col items-start gap-2 p-4 sm:flex-row sm:items-center sm:gap-3"
          >
            <div class="shrink-0 rounded-full bg-primary/10 p-2.5">
              <Users class="size-5 text-primary" />
            </div>
            <div class="min-w-0">
              <p
                class="text-xl font-bold tabular-nums sm:text-2xl"
                title={formatCount(creator.fans?.length || 0)}
              >
                {formatCount(creator.fans?.length || 0)}
              </p>
              <p
                class="text-xs font-medium tracking-wider text-muted-foreground uppercase"
              >
                Fans
              </p>
            </div>
          </CardContent>
        </Card>
      </a>
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
                Drafts
              </CardTitle>
              <CardDescription
                >{formatCount(draftCount)}
                {draftCount === 1 ? "work" : "works"} in progress</CardDescription
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
                View all
              </Button>
            {/if}
          </CardHeader>
          <CardContent class="space-y-3">
            {#if sortedDrafts.length > 0}
              {#each sortedDrafts as draft (draft.free2zaddr)}
                <div
                  class="group space-y-2 rounded-xl border bg-card p-4 transition-colors hover:border-primary/50"
                >
                  <div
                    class="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"
                  >
                    <div class="min-w-0 flex-1 space-y-1">
                      <div class="flex items-center gap-2">
                        <Badge
                          variant="secondary"
                          class="text-[10px] tracking-wide uppercase"
                          >Draft</Badge
                        >
                        <span class="text-xs text-muted-foreground"
                          >Modified {formatRelativeTime(draft.updated_at)}</span
                        >
                      </div>
                      <h3
                        class="line-clamp-2 pr-4 text-base font-semibold break-words text-foreground"
                      >
                        {draft.title || "Untitled"}
                      </h3>
                      <p class="line-clamp-1 text-sm text-muted-foreground">
                        {draft.description || "No description provided yet."}
                      </p>
                    </div>
                    <Button
                      href={`/edit?id=${encodeURIComponent(draft.free2zaddr)}`}
                      size="sm"
                    >
                      Continue Writing
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
                    None of your most recently created pages are drafts, so
                    there are none to show here.
                  </p>
                  <Button href={allPagesUrl} variant="link" size="sm"
                    >View all your drafts</Button
                  >
                {:else}
                  <p class="text-sm text-muted-foreground">No active drafts.</p>
                  <Button href="/edit" variant="link" size="sm"
                    >Create a new page</Button
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
                Published
              </CardTitle>
              <CardDescription
                >{formatCount(publishedCount)} live {publishedCount === 1
                  ? "page"
                  : "pages"}</CardDescription
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
                View all
              </Button>
            {/if}
          </CardHeader>
          <CardContent class="space-y-3">
            {#if publishedPages.length > 0}
              {#each publishedPages as page (page.free2zaddr)}
                <div
                  class="group space-y-2 rounded-xl border bg-card p-4 transition-colors hover:border-primary/50"
                >
                  <div
                    class="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"
                  >
                    <div class="min-w-0 flex-1 space-y-1">
                      <div class="flex items-center gap-2">
                        <Badge
                          variant="default"
                          class="text-[10px] tracking-wide uppercase"
                          >Published</Badge
                        >
                        <span class="text-xs text-muted-foreground"
                          >{formatRelativeTime(page.updated_at)}</span
                        >
                      </div>
                      <h3
                        class="line-clamp-2 pr-4 text-base font-semibold break-words text-foreground"
                      >
                        <a
                          href={pageUrl(page)}
                          class="transition-colors hover:text-primary hover:underline"
                          >{page.title}</a
                        >
                      </h3>
                      <p class="line-clamp-1 text-sm text-muted-foreground">
                        {page.description || "No description provided."}
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
                        <Edit3 class="mr-1.5 size-3.5" /> Edit
                      </Button>
                      <Button href={pageUrl(page)} size="sm" variant="outline">
                        <Eye class="mr-1.5 size-3.5" /> View
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
                    None of your most recently created pages are published, so
                    there are none to show here.
                  </p>
                  <Button href={allPagesUrl} variant="link" size="sm"
                    >View all your pages</Button
                  >
                {:else}
                  <p class="text-sm text-muted-foreground">
                    Nothing published yet.
                  </p>
                  <Button href="/edit" variant="link" size="sm"
                    >Create your first page</Button
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
            <CardTitle class="text-base">Quick Actions</CardTitle>
          </CardHeader>
          <CardContent class="space-y-2">
            <Button href="/edit" class="w-full justify-start" variant="default">
              <Edit3 class="mr-2 size-4" /> Create New Article
            </Button>
            <Button
              href={`/${creator.username}/dashboard/stream`}
              variant="outline"
              class="w-full justify-start"
            >
              <Users class="mr-2 size-4" /> Start Live Stream
            </Button>
            <Button
              href={`/${creator.username}/dashboard/media`}
              variant="outline"
              class="w-full justify-start"
            >
              <UploadCloud class="mr-2 size-4" /> Upload Media
            </Button>
          </CardContent>
        </Card>

        <!-- Quick Upload -->
        <Card>
          <CardHeader>
            <CardTitle class="text-base">Quick Upload</CardTitle>
          </CardHeader>
          <CardContent>
            <MediaUploader />
          </CardContent>
        </Card>

        <!-- About Card -->
        <Card>
          <CardHeader>
            <CardTitle class="text-base">Creator Bio</CardTitle>
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
                Add a bio to tell supporters what you are creating.
              </p>
            {/if}

            <div class="space-y-3 border-t pt-4">
              <div class="flex items-center justify-between gap-2">
                <span
                  class="flex shrink-0 items-center text-xs font-medium text-muted-foreground"
                >
                  <Wallet class="mr-2 size-4 text-primary" /> Zcash Wallet
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
                    aria-label="Copy Zcash address"
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
                      Copied!
                    {:else if addressCopyState === "failed"}
                      Copy failed
                    {/if}
                  </p>
                {:else}
                  <Badge variant="secondary">Not Configured</Badge>
                {/if}
              </div>
              <div class="flex items-center justify-between">
                <span
                  class="flex items-center text-xs font-medium text-muted-foreground"
                >
                  <Star class="mr-2 size-4 text-primary" /> Membership
                </span>
                <span class="text-sm font-semibold">
                  {creator.member_price
                    ? `${formatTuzis(creator.member_price)} 2Z/mo`
                    : "Free"}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  </div>
</main>
