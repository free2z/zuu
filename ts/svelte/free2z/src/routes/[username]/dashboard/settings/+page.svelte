<script lang="ts">
  import type { PageData } from "./$types";
  import * as env from "$app/env/public";
  import { apiFetch } from "$lib/api/config";
  import { sanitizeZcashAddressInput } from "$lib/utils/zcashAddress";
  import { authStore } from "$lib/stores/auth";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Label } from "$lib/components/ui/label";
  import { Badge } from "$lib/components/ui/badge";
  import { Switch } from "$lib/components/ui/switch";
  import {
    Loader2,
    Save,
    ShieldCheck,
    User,
    Camera,
    CheckCircle2,
    InfoIcon,
  } from "@lucide/svelte";
  import { onDestroy } from "svelte";
  import * as Tabs from "$lib/components/ui/tabs";
  import SecuritySettings from "$lib/components/settings/SecuritySettings.svelte";
  import AccountSettings from "$lib/components/settings/AccountSettings.svelte";
  import OutboundLinkSettings from "$lib/components/settings/OutboundLinkSettings.svelte";
  import { getCurrentLocale, tStore as t } from "$lib/i18n";
  import {
    UploadRequestError,
    explainUploadRejection,
    uploadErrorMessage,
    uploadPublicFile,
  } from "$lib/api/uploads";
  import { preflightUpload } from "$lib/components/media/uploadRequest";
  import {
    MEMBER_PRICE_MAX,
    MEMBER_PRICE_MIN,
    memberPriceProblemMessage,
    parseMemberPrice,
  } from "$lib/utils/member-price";
  import { readProfileSaveFailure } from "$lib/profile-save-errors";

  export let data: PageData;

  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";

  // No size constant here. The ceiling is the creator's monetization tier and
  // the server is the only thing that knows it: a hardcoded 5 MB refused a
  // 6 MB avatar from a creator whose tier allows far more. `preflightUpload`
  // asks `GET /api/uploads/limits/`.
  const ALLOWED_FILE_TYPES = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
  ];

  let creator = data.creator;
  let settingsTab = "financial";

  let fullName = creator.full_name || "";
  let description = creator.description || "";
  let p2paddr = creator.p2paddr || "";
  // The input's raw text. `member_price` is a DRF decimal string, never null
  // ("0" = free membership); it is parsed only at save time.
  let memberPrice: string = creator.member_price ?? "";
  let updateAll = false;

  let avatarPreview = buildImageUrl(creator.avatar_image);
  let bannerPreview = buildImageUrl(creator.banner_image);
  let avatarFile: File | null = null;
  let bannerFile: File | null = null;

  let isSaving = false;
  let saveError = "";
  let saveSuccess = "";
  /**
   * Field name -> the sentence shown beside that input: the client's own
   * member_price check, or whatever the server refused.
   */
  let fieldErrors: Record<string, string> = {};

  /** A save the server refused, already worded for the banner. */
  class SaveRefused extends Error {}

  let avatarObjectUrl: string | null = null;
  let bannerObjectUrl: string | null = null;

  function buildImageUrl(image: any) {
    if (!image?.url && !image?.thumbnail) return "";
    const imageUrl = image.thumbnail || image.url;
    if (/^https?:\/\//.test(imageUrl)) return imageUrl;
    return `${apiBase}${imageUrl.startsWith("/") ? "" : "/"}${imageUrl}`;
  }

  /**
   * The type check is ours (the image types the avatar/banner slots render);
   * the size check is the server's limit for THIS creator, read through the
   * shared upload helper. An unreadable limit refuses nothing: the upload's
   * own pre-check and the server still decide.
   */
  async function validateFile(file: File): Promise<string | null> {
    if (!ALLOWED_FILE_TYPES.includes(file.type)) {
      return $t(
        "dashboard.settings.errors.invalidFileType",
        "Invalid file type. Please upload a JPEG, PNG, WEBP, or GIF image.",
      );
    }
    try {
      await preflightUpload(file, { request: apiFetch });
    } catch (error) {
      if (error instanceof UploadRequestError) {
        return uploadErrorMessage(error, $t, getCurrentLocale());
      }
    }
    return null;
  }

  // A later pick supersedes an earlier one whose limit read is still pending.
  let avatarPick = 0;
  let bannerPick = 0;
  /**
   * The pick still being checked against the limit, resolving to its refusal
   * (or null). Save awaits these: without it, Save pressed during the limit
   * read sent a PATCH without the image, reported success, and THEN the
   * preview switched to the unsaved file (codex review of ).
   */
  let avatarChecking: Promise<string | null> | null = null;
  let bannerChecking: Promise<string | null> | null = null;

  async function handleAvatarChange(
    event: Event & { currentTarget: EventTarget & HTMLInputElement },
  ) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    const pick = ++avatarPick;

    const checking = validateFile(file);
    avatarChecking = checking;
    const error = await checking;
    if (pick !== avatarPick) return;
    avatarChecking = null;
    if (error) {
      saveError = error;
      input.value = ""; // Reset input
      return;
    }
    saveError = "";

    avatarFile = file;
    if (avatarObjectUrl) URL.revokeObjectURL(avatarObjectUrl);
    avatarObjectUrl = URL.createObjectURL(file);
    avatarPreview = avatarObjectUrl;
  }

  async function handleBannerChange(
    event: Event & { currentTarget: EventTarget & HTMLInputElement },
  ) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    const pick = ++bannerPick;

    const checking = validateFile(file);
    bannerChecking = checking;
    const error = await checking;
    if (pick !== bannerPick) return;
    bannerChecking = null;
    if (error) {
      saveError = error;
      input.value = ""; // Reset input
      return;
    }
    saveError = "";

    bannerFile = file;
    if (bannerObjectUrl) URL.revokeObjectURL(bannerObjectUrl);
    bannerObjectUrl = URL.createObjectURL(file);
    bannerPreview = bannerObjectUrl;
  }

  /**
   * The shared, bounded upload. This used to be a bare `apiFetch`
   * with no timeout: when nginx answered 500 mid-body  the request
   * never settled, the Save button spun forever and nothing was shown. Now
   * the file is checked against the server's limit first, a stalled request
   * is aborted, and every failure is an `UploadRequestError` that
   * `handleSave` turns into a message naming the file and its size.
   */
  async function uploadImage(file: File, title: string) {
    try {
      return await uploadPublicFile(file, title);
    } catch (error) {
      // nginx's 403 has no body; re-read the limit so it can be explained.
      throw await explainUploadRejection(error, { request: apiFetch });
    }
  }

  /** The names the error banner uses for the fields the server may refuse. */
  function fieldLabels(): Record<string, string> {
    return {
      full_name: $t("dashboard.settings.displayName", "Display Name"),
      description: $t("dashboard.settings.biography", "Biography"),
      p2paddr: $t("dashboard.settings.zcashAddress", "Zcash Address"),
      member_price: $t(
        "dashboard.settings.membershipPriceName",
        "Membership price",
      ),
      avatar_image: $t("dashboard.settings.avatarAlt", "Profile avatar"),
      banner_image: $t("profile.bannerAlt", "Profile banner"),
    };
  }

  async function handleSave() {
    saveError = "";
    saveSuccess = "";
    fieldErrors = {};

    // An image picked a moment ago may still be waiting on its limit check;
    // saving without it would report success for an image never uploaded.
    // isSaving first, so the button cannot be pressed twice meanwhile.
    // A loop, not one await: a replacement picked while Save waits installs
    // a NEW pending check, and the one captured first no longer describes the
    // image the creator means to save (codex review round 2).
    if (avatarChecking || bannerChecking) {
      isSaving = true;
      let refusals: (string | null)[] = [];
      while (avatarChecking || bannerChecking) {
        refusals = await Promise.all([avatarChecking, bannerChecking]);
      }
      isSaving = false;
      // The pick handler has already put its refusal in the banner, and
      // dropped the file; saving now would replace that message with a
      // success the creator did not ask for.
      if (refusals.some(Boolean)) return;
    }

    // Checked BEFORE anything is uploaded: a price the server will refuse
    // must not cost the creator an image upload first. Same rules as the
    // server ($lib/utils/member-price), so nothing it would take is refused.
    const submittedPrice = memberPrice;
    const price = parseMemberPrice(submittedPrice);
    if (!price.ok) {
      const message = memberPriceProblemMessage(
        price.problem,
        $t,
        getCurrentLocale(),
      );
      fieldErrors = { member_price: message };
      saveError = `${fieldLabels().member_price}: ${message}`;
      return;
    }

    isSaving = true;

    try {
      let avatarImageId: number | null = null;
      let bannerImageId: number | null = null;

      if (avatarFile) {
        const uploadedAvatar = await uploadImage(
          avatarFile,
          `${creator.username}-avatar`,
        );
        avatarImageId = uploadedAvatar.id;
      }

      if (bannerFile) {
        const uploadedBanner = await uploadImage(
          bannerFile,
          `${creator.username}-banner`,
        );
        bannerImageId = uploadedBanner.id;
      }

      const payload: Record<string, any> = {
        full_name: fullName.trim(),
        description: description.trim(),
        p2paddr: sanitizeZcashAddressInput(p2paddr),
        // null = no membership; otherwise a canonical whole number of 2Z.
        member_price: price.value,
      };

      if (updateAll) {
        payload.updateAll = true;
      }

      if (avatarImageId) payload.avatar_image = avatarImageId;
      if (bannerImageId) payload.banner_image = bannerImageId;

      const response = await apiFetch("/api/auth/user/", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        // The server says which field and why, and that is the message. It
        // used to be discarded for "Failed to save settings.".
        const failure = await readProfileSaveFailure(response, {
          labels: fieldLabels(),
          genericMessage: $t(
            "dashboard.settings.errors.saveFailed",
            "Failed to save settings.",
          ),
          summaryMessage: $t(
            "dashboard.settings.errors.saveRefused",
            "The server refused these settings. Check the fields and try again.",
          ),
        });
        fieldErrors = failure.fieldErrors;
        throw new SaveRefused(failure.saveError);
      }

      creator = await response.json();
      // Show the canonical saved value ("1.0" -> "1") -- unless the creator
      // edited the field while the save was in flight, in which case their
      // newer text wins and stays unsaved, visibly (codex review of ).
      if (memberPrice === submittedPrice) {
        memberPrice = creator.member_price ?? "";
      }
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
      saveSuccess = $t(
        "dashboard.settings.saveSuccess",
        "Profile updated successfully.",
      );

      // Clear success message after 3 seconds
      setTimeout(() => (saveSuccess = ""), 3000);
    } catch (error) {
      // Each failure keeps its own words; only an unexpected one (a network
      // error on the PATCH itself) falls back to the generic sentence.
      saveError =
        error instanceof UploadRequestError
          ? uploadErrorMessage(error, $t, getCurrentLocale())
          : error instanceof SaveRefused
            ? error.message
            : $t(
                "dashboard.settings.errors.saveFailed",
                "Failed to save settings.",
              );
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
  <title
    >{$t("dashboard.settings.metaTitle", "Settings • {username}", {
      username: creator.username,
    })}</title
  >
  <meta
    name="description"
    content={$t(
      "dashboard.settings.metaDescription",
      "Update your profile, address, and images.",
    )}
  />
</svelte:head>

<main class="flex-1 bg-background pb-20 text-foreground">
  <div class="container mx-auto max-w-6xl py-10">
    <header
      class="mb-8 flex flex-col justify-between gap-6 md:flex-row md:items-center"
    >
      <div class="space-y-1">
        <div class="flex items-center gap-3">
          <h1 class="text-3xl font-bold tracking-tight">
            {$t("auth.settings", "Settings")}
          </h1>
          {#if creator.is_verified}
            <Badge
              variant="secondary"
              class="border-transparent bg-blue-100 text-blue-600 hover:bg-blue-100/80 dark:bg-blue-900/30 dark:text-blue-400"
            >
              <ShieldCheck class="mr-1 size-3.5" />
              {$t("creators.filters.verified", "Verified")}
            </Badge>
          {/if}
        </div>
        <p class="text-muted-foreground">
          {$t(
            "dashboard.settings.description",
            "Manage your account settings and set email preferences.",
          )}
        </p>
      </div>

      <!--
        Desktop actions. The mobile copy lives in the sticky dock at the foot of
        the page: this header scrolls out of view after ~200px of a form that
        is 2,200px tall on a phone, so "Save Changes" was unreachable without
        scrolling all the way back to the top.
      -->
      <div class="hidden items-center gap-4 md:flex">
        <div class="mr-2 flex items-center gap-3">
          {#if saveError}
            <div
              role="alert"
              class="animate-in text-sm font-medium text-destructive fade-in slide-in-from-top-1"
            >
              {saveError}
            </div>
          {/if}
          {#if saveSuccess}
            <div
              role="status"
              class="flex animate-in items-center text-sm font-medium text-green-600 fade-in slide-in-from-top-1"
            >
              <CheckCircle2 class="mr-2 size-4" />
              {saveSuccess}
            </div>
          {/if}
        </div>
        <Button href={`/${creator.username}`} variant="ghost"
          >{$t("dashboard.settings.discard", "Discard")}</Button
        >
        <Button onclick={handleSave} disabled={isSaving}>
          {#if isSaving}
            <Loader2 class="mr-2 size-4 animate-spin" />
            {$t("editor.saving", "Saving...")}
          {:else}
            <Save class="mr-2 size-4" />
            {$t("dashboard.settings.saveChanges", "Save Changes")}
          {/if}
        </Button>
      </div>
    </header>

    <div class="flex flex-col gap-8 lg:flex-row">
      <!-- Sidebar Profile Section -->
      <aside class="w-full shrink-0 space-y-6 lg:w-80">
        <div
          class="relative overflow-hidden rounded-xl border bg-background shadow-sm"
        >
          <div class="relative h-32 w-full bg-muted">
            {#if bannerPreview}
              <img
                src={bannerPreview}
                alt={$t("profile.bannerAlt", "Profile banner")}
                class="h-full w-full object-cover"
              />
            {/if}
            <!--
              The control used to be an `opacity-0 hover:opacity-100` overlay.
              A phone has no hover, so on touch the ONLY way to discover that
              the banner was editable was to tap a completely unmarked grey
              rectangle. The badge is always visible now, and the file input is
              the badge rather than the whole banner, so the tap target is a
              named 44px control instead of an invisible one. Top-RIGHT, not
              bottom: the avatar overlaps the banner's bottom edge.
            -->
            <label
              class="absolute top-3 right-3 flex size-11 cursor-pointer items-center justify-center rounded-full border border-border bg-background/90 shadow-sm backdrop-blur transition-colors hover:bg-background"
              title={$t(
                "dashboard.settings.uploadBanner",
                "Upload banner image",
              )}
            >
              <Camera class="size-5" aria-hidden="true" />
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                on:change={handleBannerChange}
                class="sr-only"
                aria-label={$t(
                  "dashboard.settings.uploadBanner",
                  "Upload banner image",
                )}
              />
            </label>
          </div>

          <div class="relative z-10 px-6 pb-6">
            <div class="-mt-12 mb-4 flex flex-col items-center">
              <div class="group/avatar relative mb-3">
                <div
                  class="h-24 w-24 overflow-hidden rounded-xl border-4 border-background bg-muted shadow-sm"
                >
                  {#if avatarPreview}
                    <img
                      src={avatarPreview}
                      alt={$t("dashboard.settings.avatarAlt", "Profile avatar")}
                      class="h-full w-full object-cover"
                    />
                  {:else}
                    <div
                      class="flex h-full w-full items-center justify-center bg-muted text-muted-foreground"
                    >
                      <User class="size-8" />
                    </div>
                  {/if}
                </div>
                <!--
                  Same story as the banner: hover-only on a device with no
                  hover is not an affordance. A permanently visible 44px badge
                  on the avatar's corner, which is also its own file input.
                -->
                <label
                  class="absolute -right-2 -bottom-2 flex size-11 cursor-pointer items-center justify-center rounded-full border-2 border-background bg-primary text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
                  title={$t("dashboard.settings.uploadAvatar", "Upload avatar")}
                >
                  <Camera class="size-5" aria-hidden="true" />
                  <input
                    type="file"
                    accept="image/*"
                    on:change={handleAvatarChange}
                    class="sr-only"
                    aria-label={$t(
                      "dashboard.settings.uploadAvatar",
                      "Upload avatar",
                    )}
                  />
                </label>
              </div>

              <div class="text-center">
                <h2 class="max-w-60 truncate text-xl font-bold">
                  {fullName || creator.username}
                </h2>
                <p class="text-sm text-muted-foreground">@{creator.username}</p>
              </div>
            </div>

            <div class="space-y-4 border-t pt-2">
              <div class="grid gap-2">
                <Label for="fullName"
                  >{$t("dashboard.settings.displayName", "Display Name")}</Label
                >
                <Input
                  id="fullName"
                  bind:value={fullName}
                  placeholder={$t(
                    "dashboard.settings.namePlaceholder",
                    "Your name",
                  )}
                />
                {#if fieldErrors.full_name}
                  <p class="text-sm font-medium text-destructive">
                    {fieldErrors.full_name}
                  </p>
                {/if}
              </div>

              <div class="grid gap-2">
                <Label for="bio"
                  >{$t("dashboard.settings.biography", "Biography")}</Label
                >
                <Textarea
                  id="bio"
                  rows={4}
                  bind:value={description}
                  placeholder={$t(
                    "dashboard.settings.biographyPlaceholder",
                    "Tell us about yourself",
                  )}
                />
                {#if fieldErrors.description}
                  <p class="text-sm font-medium text-destructive">
                    {fieldErrors.description}
                  </p>
                {/if}
              </div>
            </div>
          </div>
        </div>
      </aside>

      <!-- Main Content Tabs -->
      <div class="min-w-0 flex-1">
        <Tabs.Root bind:value={settingsTab} class="w-full space-y-6">
          <Tabs.List>
            <Tabs.Trigger value="financial"
              >{$t("dashboard.settings.financial", "Financial")}</Tabs.Trigger
            >
            <Tabs.Trigger value="security"
              >{$t("dashboard.settings.security", "Security")}</Tabs.Trigger
            >
            <Tabs.Trigger value="account"
              >{$t("dashboard.settings.account", "Account")}</Tabs.Trigger
            >
          </Tabs.List>

          <Tabs.Content value="financial" class="space-y-6">
            <div class="space-y-6">
              <div>
                <h3 class="text-lg font-medium">
                  {$t(
                    "dashboard.settings.payoutSettings",
                    "Direct Zcash support",
                  )}
                </h3>
                <p class="text-sm text-muted-foreground">
                  {$t(
                    "dashboard.settings.payoutDescription",
                    "Configure the wallet address for direct supporter payments and your membership pricing.",
                  )}
                </p>
              </div>

              <div class="grid gap-6">
                <div class="grid gap-2">
                  <Label for="zcash"
                    >{$t(
                      "dashboard.settings.zcashAddress",
                      "Zcash Address",
                    )}</Label
                  >
                  <!--
                    A direct support address must be verifiable at a glance, so this is
                    a wrapping textarea, never a single-line <input>: a
                    truncated address hides a transposed character and sends
                    direct Zcash support somewhere unrecoverable.
                  -->
                  <Textarea
                    id="zcash"
                    rows={2}
                    bind:value={p2paddr}
                    placeholder="zs1... or u1..."
                    spellcheck={false}
                    autocapitalize="none"
                    autocomplete="off"
                    aria-describedby="zcash-help"
                    class="resize-none font-mono text-xs leading-relaxed break-all whitespace-pre-wrap"
                    oninput={(e) => {
                      // Drop anything that cannot be part of an address —
                      // whitespace AND the zero-width characters a chat or
                      // webmail paste carries, which `\s` does not match.
                      const target = e.currentTarget as HTMLTextAreaElement;
                      const cleaned = sanitizeZcashAddressInput(target.value);
                      if (cleaned !== target.value) {
                        target.value = cleaned;
                      }
                      p2paddr = cleaned;
                    }}
                  />
                  {#if fieldErrors.p2paddr}
                    <p
                      data-testid="p2paddr-error"
                      class="text-sm font-medium text-destructive"
                    >
                      {fieldErrors.p2paddr}
                    </p>
                  {/if}
                  <p id="zcash-help" class="text-xs text-muted-foreground">
                    {$t(
                      "dashboard.settings.zcashAddressHelp",
                      "Confirm the full address matches your intended support wallet. Direct wallet transfers are irreversible. This is separate from company payment requests.",
                    )}
                  </p>

                  <!--
                    A tooltip on a 12px icon is two failures at once on a
                    phone: the target is half the 24px floor (WCAG 2.2 SC
                    2.5.8), and tooltip content opens on hover, which touch
                    never produces — so the warning about rewriting the direct support
                    address on EVERY existing article was unreadable on the
                    device most likely to be used to flip the switch. It is
                    plain text now: a caution that matters this much should not
                    be behind an interaction at all.
                  -->
                  <div class="space-y-1.5">
                    <div class="flex min-h-11 items-center gap-3">
                      <Switch id="updateAll" bind:checked={updateAll} />
                      <Label for="updateAll" class="font-normal"
                        >{$t(
                          "dashboard.settings.applyToAll",
                          "Apply to all existing articles",
                        )}</Label
                      >
                    </div>
                    <p
                      class="flex items-start gap-1.5 text-xs text-muted-foreground"
                    >
                      <InfoIcon
                        class="mt-0.5 size-3.5 shrink-0"
                        aria-hidden="true"
                      />
                      <span>
                        {$t(
                          "dashboard.settings.applyToAllWarning",
                          "This updates the direct support address on all existing articles. Confirm it is the intended wallet.",
                        )}
                      </span>
                    </p>
                  </div>
                </div>

                <div class="grid max-w-sm gap-2">
                  <Label for="memberPrice"
                    >{$t(
                      "dashboard.settings.membershipPrice",
                      "Membership price (2Z per 30 days)",
                    )}</Label
                  >
                  <!--
                    2Z, not ZEC. The price is charged in 2Z platform
                    credits every 30 days; a creator reading "ZEC" priced a
                    month at 1 2Z = $0.01. 0 IS a free membership                     (a free follow with member access); the price is required.
                    Text, not type="number": a number input reports half-typed
                    text as "", which would hide a typo as an empty field.
                  -->
                  <div class="relative">
                    <Input
                      id="memberPrice"
                      type="text"
                      inputmode="numeric"
                      autocomplete="off"
                      value={memberPrice}
                      placeholder={$t(
                        "dashboard.settings.membershipPricePlaceholder",
                        "0 = free",
                      )}
                      class="pl-12"
                      aria-invalid={fieldErrors.member_price
                        ? "true"
                        : undefined}
                      aria-describedby={fieldErrors.member_price
                        ? "memberPrice-error memberPrice-help"
                        : "memberPrice-help"}
                      oninput={(e) => {
                        memberPrice = (e.currentTarget as HTMLInputElement)
                          .value;
                        if (fieldErrors.member_price) {
                          const { member_price: _cleared, ...rest } =
                            fieldErrors;
                          fieldErrors = rest;
                        }
                      }}
                    />
                    <div
                      class="absolute top-1/2 left-3 -translate-y-1/2 text-sm font-medium text-muted-foreground"
                      aria-hidden="true"
                    >
                      2Z
                    </div>
                  </div>
                  {#if fieldErrors.member_price}
                    <p
                      id="memberPrice-error"
                      data-testid="member-price-error"
                      class="text-sm font-medium text-destructive"
                    >
                      {fieldErrors.member_price}
                    </p>
                  {/if}
                  <p
                    id="memberPrice-help"
                    class="text-sm text-muted-foreground"
                  >
                    {$t(
                      "dashboard.settings.membershipPriceHint",
                      "A whole number of 2Z credits, from {min} to {max}, charged to each member every 30 days. Set it to 0 to make membership a free follow: followers get your members-only posts and streams at no cost.",
                      {
                        min: MEMBER_PRICE_MIN.toLocaleString(
                          getCurrentLocale(),
                        ),
                        max: MEMBER_PRICE_MAX.toLocaleString(
                          getCurrentLocale(),
                        ),
                      },
                    )}
                  </p>
                </div>
              </div>
            </div>
          </Tabs.Content>

          <Tabs.Content value="security" class="space-y-6">
            <SecuritySettings
              initialMfaEnabled={Boolean((creator as any)?.mfa_enabled)}
            />
          </Tabs.Content>
          <Tabs.Content value="account" class="space-y-6">
            <AccountSettings
              username={creator.username}
              initialEmail={creator.email}
            />
          </Tabs.Content>
        </Tabs.Root>
        <OutboundLinkSettings />
      </div>
    </div>

    <!--
      Mobile save dock. Two separate defects met here:

      1. The header actions are ~200px into a 2,200px page on a phone, so
         saving meant scrolling back to the top of the form you had just
         filled in.
      2. `saveError` and `saveSuccess` were rendered ONLY inside a
         `hidden lg:flex` container. Below 1024px a failed save produced no
         message of any kind — the button simply stopped spinning and nothing
         had been written.

      `sticky` rather than `fixed`: it stays in flow, so it releases above the
      footer instead of covering it rather than hovering over it forever.

      `bottom` is `--f2z-bottom-dock-height`, not 0. That variable is the
      repo's bottom-dock contract: `ClassicUiBanner` is `fixed` at the bottom
      at `z-40` for up to eight seconds on the production hosts (never on
      127.0.0.1, so no test can see it) and publishes its measured height
      there; `PageActions` already rides on top of it the same way. Without
      this the banner would land squarely on the only mobile Save/Discard
      controls on the page. Found by the codex review of this change.

      `-mx-2` is exactly the layout `<main>`'s `px-2`, so the bar bleeds to the
      viewport edge and no further. `-mx-4` overflowed the document by 8px at
      320px — measured, not guessed.
    -->
    <div
      class="sticky z-30 -mx-2 mt-8 border-t border-border bg-background/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur md:hidden"
      style="bottom: var(--f2z-bottom-dock-height, 0px);"
      data-testid="settings-mobile-actions"
    >
      {#if saveError}
        <p
          role="alert"
          data-testid="settings-save-error"
          class="mb-2 text-sm font-medium text-destructive"
        >
          {saveError}
        </p>
      {/if}
      {#if saveSuccess}
        <p
          role="status"
          data-testid="settings-save-success"
          class="mb-2 flex items-center text-sm font-medium text-green-600"
        >
          <CheckCircle2 class="mr-2 size-4 shrink-0" />
          {saveSuccess}
        </p>
      {/if}
      <div class="flex items-center gap-3">
        <Button
          href={`/${creator.username}`}
          variant="outline"
          class="h-11 flex-1"
        >
          {$t("dashboard.settings.discard", "Discard")}
        </Button>
        <Button
          onclick={handleSave}
          disabled={isSaving}
          class="h-11 flex-[2]"
          data-testid="settings-save-mobile"
        >
          {#if isSaving}
            <Loader2 class="mr-2 size-4 animate-spin" />
            {$t("editor.saving", "Saving...")}
          {:else}
            <Save class="mr-2 size-4" />
            {$t("dashboard.settings.saveChanges", "Save Changes")}
          {/if}
        </Button>
      </div>
    </div>
  </div>
</main>
