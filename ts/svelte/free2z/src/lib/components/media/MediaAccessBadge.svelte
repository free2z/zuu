<script lang="ts">
  /**
   * The one place a media surface says who can open a file.
   *
   * `CoverLibraryPanel` used to render `{item.access || "Private"}` — the raw
   * server enum, untranslated, in the same muted line as the MIME type, which
   * is both unreadable in three of four locales and invisible as a warning.
   * Labels come from the `media.access*` catalog keys the dashboard and the
   * uploader already use, so the tier is called the same thing everywhere.
   *
   * `normalizeMediaAccess` resolves anything unrecognised to `private`, which
   * is the safe direction: a value we cannot read must never be advertised as
   * shareable.
   */
  import { tStore as t } from "$lib/i18n";
  import { normalizeMediaAccess } from "./mediaAccess";

  interface Props {
    access?: string | null;
    /** Extra classes for the host span. */
    class?: string;
  }

  let { access, class: className = "" }: Props = $props();

  const level = $derived(normalizeMediaAccess(access));

  const label = $derived(
    level === "public"
      ? $t("media.accessPublic", "Public")
      : level === "members"
        ? $t("media.accessMembers", "Subscribers")
        : $t("media.accessPrivate", "Private"),
  );

  const note = $derived(
    level === "public"
      ? $t("media.publicLink", "Public — anyone with the link can open it")
      : level === "members"
        ? $t("media.membersLink", "Subscribers only — nobody else can open it")
        : $t("media.privateLink", "Private — only you can open it"),
  );

  // Public is the unremarkable case and stays muted; the two restricted tiers
  // are the ones that can break a page, so they carry the accent. One cue per
  // element — a tinted pill, not a pill plus a ring plus an icon.
  const tone = $derived(
    level === "public"
      ? "border-border/60 bg-muted/60 text-muted-foreground"
      : "border-amber-500/40 bg-amber-500/12 text-amber-700 dark:text-amber-300",
  );
</script>

<span
  data-media-access={level}
  title={note}
  class={`inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[10px] leading-none font-medium ${tone} ${className}`}
>
  {label}
</span>
