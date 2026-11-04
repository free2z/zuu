<script lang="ts">
  import { tStore as t } from "$lib/i18n";
  import { streamWatchPath } from "$lib/utils/stream-path";
  import type { PublicMeetingList } from "$lib/api/f2z.schemas";

  type Stream = PublicMeetingList;

  export let streams: Stream[] = [];
  /** Match the column of the content below (the anonymous intro is narrower). */
  export let narrow = false;
  export let imageUrl: (path?: string | null) => string | null;
  export let modeLabel: (stream: Stream) => string;
  export let ariaLabel: (stream: Stream) => string;

  // Avatar-less creators still get a tint of their own, stable per username.
  const FALLBACK_TINTS = [
    "linear-gradient(135deg,#f97316,#db2777)",
    "linear-gradient(135deg,#eab308,#16a34a)",
    "linear-gradient(135deg,#6366f1,#06b6d4)",
    "linear-gradient(135deg,#a855f7,#ec4899)",
    "linear-gradient(135deg,#14b8a6,#0ea5e9)",
  ];
  function fallbackTint(name: string): string {
    let hash = 0;
    for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return FALLBACK_TINTS[hash % FALLBACK_TINTS.length];
  }

  $: items = streams.map((stream) => {
    const img = imageUrl(stream.avatar);
    return {
      key: stream.username + ":" + stream.meeting_type,
      href: streamWatchPath(stream.username, stream.meeting_type),
      name: stream.username,
      initials: stream.username?.slice(0, 2).toUpperCase(),
      img,
      // The capsule is tinted by a blurred copy of the creator's own avatar,
      // so every pill carries that person's colours.
      tint: img
        ? `url(${JSON.stringify(img)}) center / cover`
        : fallbackTint(stream.username ?? ""),
      mode: modeLabel(stream),
      label: ariaLabel(stream),
    };
  });
</script>

<!-- Live rail: a quiet strip that reads as the header line of the page below
     it (same column, mono label over a dashed rule, like "Featured Story"). The negative bottom margin
     cancels most of the shell gap so it sits with the hero, not apart from it. -->
<section
  data-testid="homepage-live-now"
  aria-labelledby="homepage-live-now-heading"
  class="relative z-10 -mb-6 px-4 sm:px-6 md:-mt-2 md:-mb-8 lg:-mt-5 lg:-mb-16 lg:px-8"
>
  <div
    class="mx-auto flex max-w-7xl min-w-0 flex-col gap-2.5 {narrow
      ? 'lg:max-w-6xl'
      : ''}"
  >
    <div class="flex items-center gap-3">
      <h2
        id="homepage-live-now-heading"
        class="flex shrink-0 items-center gap-2 font-mono text-[11px] font-bold tracking-[0.2em] text-red-500 uppercase"
      >
        <span class="live-dot" aria-hidden="true"></span>
        <span>{$t("homepage.liveNow", "Live Now")}</span>
        <span
          class="font-normal tracking-normal text-muted-foreground"
          aria-hidden="true">· {items.length}</span
        >
      </h2>
      <span
        class="h-px min-w-8 flex-1 border-t border-dashed border-border/50"
        aria-hidden="true"
      ></span>
    </div>

    <ul
      class="rail-scroll -mx-4 -my-2 flex min-w-0 items-center gap-2.5 overflow-x-auto px-4 py-2 sm:mx-0 sm:px-0"
    >
      {#each items as it (it.key)}
        <li class="shrink-0">
          <a
            data-testid="homepage-live-now-card"
            href={it.href}
            aria-label={it.label}
            class="capsule group relative flex items-center gap-2.5 overflow-hidden rounded-full border border-white/10 bg-background/40 py-1.5 pr-4 pl-1.5 backdrop-blur-sm transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-px hover:border-red-500/40 focus-visible:ring-2 focus-visible:ring-red-500/60 focus-visible:outline-none motion-reduce:transition-none motion-reduce:hover:translate-y-0"
          >
            <span
              class="pointer-events-none absolute inset-0 scale-150 opacity-25 blur-xl saturate-150 transition-opacity duration-300 group-hover:opacity-45"
              style:background={it.tint}
              aria-hidden="true"
            ></span>
            <span
              class="pointer-events-none absolute inset-0 rounded-full bg-linear-to-b from-white/[0.07] to-transparent"
              aria-hidden="true"
            ></span>

            <span class="live-ring relative shrink-0 rounded-full">
              <span
                class="grid size-7 place-items-center overflow-hidden rounded-full text-[10px] font-bold text-white"
                style:background={it.img ? undefined : it.tint}
              >
                {#if it.img}
                  <img
                    src={it.img}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    class="size-full object-cover"
                  />
                {:else}
                  {it.initials}
                {/if}
              </span>
            </span>

            <span
              class="relative text-sm font-semibold whitespace-nowrap text-foreground"
              >{it.name}</span
            >
            <span
              class="relative font-mono text-[10.5px] whitespace-nowrap text-foreground/65 transition-colors group-hover:text-foreground/85"
              >{it.mode}</span
            >
          </a>
        </li>
      {/each}
    </ul>
  </div>
</section>

<style>
  .live-dot {
    position: relative;
    display: inline-flex;
    width: 6px;
    height: 6px;
    flex-shrink: 0;
    border-radius: 9999px;
    background: rgb(239 68 68);
  }
  .live-dot::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: inherit;
    animation: live-ping 1.4s cubic-bezier(0, 0, 0.2, 1) infinite;
  }
  @keyframes live-ping {
    75%,
    100% {
      transform: scale(2.4);
      opacity: 0;
    }
  }

  /* Red "on air" ring with a slow breathing glow. */
  .live-ring {
    box-shadow:
      0 0 0 2px var(--background, #0a0c09),
      0 0 0 3.5px rgb(239 68 68);
    animation: live-breathe 2.4s ease-in-out infinite;
  }
  @keyframes live-breathe {
    0%,
    100% {
      box-shadow:
        0 0 0 2px var(--background, #0a0c09),
        0 0 0 3.5px rgb(239 68 68),
        0 0 0 3.5px rgb(239 68 68 / 0);
    }
    50% {
      box-shadow:
        0 0 0 2px var(--background, #0a0c09),
        0 0 0 3.5px rgb(239 68 68),
        0 0 10px 3px rgb(239 68 68 / 0.35);
    }
  }

  .capsule:hover {
    box-shadow:
      0 8px 24px -12px rgb(239 68 68 / 0.55),
      inset 0 1px 0 rgb(255 255 255 / 0.06);
  }

  .rail-scroll {
    scrollbar-width: none;
    mask-image: linear-gradient(
      to right,
      #000 calc(100% - 2.5rem),
      transparent
    );
  }
  .rail-scroll::-webkit-scrollbar {
    display: none;
  }
  @media (min-width: 640px) {
    .rail-scroll {
      mask-image: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .live-dot::after,
    .live-ring {
      animation: none;
    }
  }
</style>
