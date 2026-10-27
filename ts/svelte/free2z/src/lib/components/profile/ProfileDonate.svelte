<script lang="ts">
  import { onDestroy } from "svelte";
  import { toast, captureAccountToast, toastPresentation } from "$lib/toast.js";
  import QRCode from "qrcode";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Tabs from "$lib/components/ui/tabs";
  import { Button, buttonVariants } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { Label } from "$lib/components/ui/label";
  import { Separator } from "$lib/components/ui/separator";
  import {
    Check,
    CircleCheck,
    Coins,
    Copy,
    ExternalLink,
    HeartHandshake,
    ShieldCheck,
    Wallet,
  } from "@lucide/svelte";
  import { locale, tStore as t } from "$lib/i18n";
  import { authStore, currentUser } from "$lib/stores/auth";
  import { requestLogin } from "$lib/stores/auth-modal";
  import { loginDestination } from "$lib/login-destination";
  import { page } from "$lib/kit-stores";
  import type { CreatorDetail, SimpleCreator } from "$lib/api/f2z.schemas";
  import { tuzisDonateIdempotentCreate } from "$lib/api/tuzis/tuzis";
  import type { ButtonVariant } from "$lib/components/ui/button";
  import InsufficientFunds from "$lib/components/InsufficientFunds.svelte";
  import {
    compareDecimalText,
    formatDecimalText,
    insufficientFundsFromError,
    makeInsufficientFunds,
    type InsufficientFundsDetails,
  } from "$lib/insufficient-funds";
  import {
    clearDonationIdempotencyKey,
    donationIdempotencyKey,
    isIdempotencyStorageCleanupFailure,
    isIdempotencyStorageUnavailable,
  } from "$lib/subscribe-idempotency";
  import {
    ZCASH_MEMO_MAX_BYTES,
    addressAcceptsMemo,
    buildDirectSupportUri,
    defaultSupportMemo,
  } from "$lib/zcash-support-uri";

  type SupportReceipt = {
    amount: number;
    anonymous: boolean;
    recipient: string;
    pageTitle?: string | null;
  };

  let {
    creator,
    pageId = null,
    pageTitle = null,
    pageAddress = null,
    triggerLabel = "Support",
    triggerVariant = "default",
    triggerClass = "",
    triggerIconOnly = false,
    navigationPending = false,
  }: {
    creator: CreatorDetail | SimpleCreator;
    pageId?: string | null;
    pageTitle?: string | null;
    /**
     * The zPage's EFFECTIVE support address (`article.p2paddr`, which the API
     * already resolves as the page override falling back to the creator's).
     * A page can deliberately route support to a campaign wallet, so zPage
     * support must pay this, never `creator.p2paddr`.
     */
    pageAddress?: string | null;
    triggerLabel?: string;
    triggerVariant?: ButtonVariant;
    triggerClass?: string;
    triggerIconOnly?: boolean;
    navigationPending?: boolean;
  } = $props();

  let destroyed = false;
  onDestroy(() => (destroyed = true));

  let open = $state(false);
  let copied = $state(false);
  let donationAmount = $state(5);
  let zecAmount = $state("");
  let anonymous = $state(false);
  let sending = $state(false);
  let qrDataUrl = $state<string | null>(null);
  let qrError = $state(false);
  let receipt = $state<SupportReceipt | null>(null);
  let copiedResetTimeout: ReturnType<typeof setTimeout> | undefined;
  let paymentMethod = $state<"tuzis" | "zcash">("tuzis");
  let tuzisPanel = $state<HTMLDivElement | null>(null);
  let zcashPanel = $state<HTMLDivElement | null>(null);
  let insufficientFunds = $state<InsufficientFundsDetails | null>(null);
  let paymentError = $state<{ message: string; generation: number } | null>(
    null,
  );
  $effect(() => {
    if (
      paymentError &&
      paymentError.generation !== $toastPresentation.generation
    )
      paymentError = null;
  });
  let lastFundsInputs = $state<string | null>(null);
  let dialogGeneration = 0;
  let lastContextKey = $state<string | null>(null);

  // This component stays mounted while the reused zPage route is loading. A
  // portal would otherwise leave the outgoing page's payment dialog over the
  // loading state, and its props would switch to the destination page before
  // the reader had consciously opened that payment flow.
  $effect(() => {
    if (navigationPending) {
      open = false;
      resetDialog();
    }
  });

  // A reused route can change payment context before the old request settles.
  // Treat every context change as a new dialog generation, including a
  // same-page back/forward cycle that happens to restore the same props.
  $effect(() => {
    const contextKey = `${creator.id}|${creator.username}|${pageId ?? ""}|${pageAddress ?? ""}`;
    if (lastContextKey !== null && lastContextKey !== contextKey) {
      resetDialog();
    }
    lastContextKey = contextKey;
  });

  $effect(() => {
    const inputs = `${donationAmount}:${balance}`;
    if (lastFundsInputs !== null && lastFundsInputs !== inputs) {
      insufficientFunds = null;
    }
    lastFundsInputs = inputs;
  });

  let user = $derived($authStore.creator);
  let balance = $derived(user?.tuzis ?? "0");
  let canAfford = $derived(
    compareDecimalText(balance, String(donationAmount)) >= 0,
  );
  const quickAmounts = [2, 5, 10, 20];

  // Direct support pays the creator, peer to peer. On a zPage the recipient is
  // the page's effective address; on a profile it is the creator's. Free2Z's
  // own address is NEVER a recipient here -- that is the "buy 2Z" flow in the
  // billing dashboard, and it is the only ZEC flow Free2Z processes.
  let recipientAddress = $derived(
    (pageId ? pageAddress || creator?.p2paddr : creator?.p2paddr) ?? "",
  );
  let recipientAcceptsMemo = $derived(addressAcceptsMemo(recipientAddress));

  // The memo is a note from the supporter to the creator. It is never sent to
  // Free2Z, never logged, and never carries a page id or routing command. The
  // draft is re-keyed on the recipient so a private note cannot follow the
  // dialog to a different creator or page.
  let memo = $state("");
  let memoKey = $derived(`${pageId ?? ""}|${recipientAddress}`);
  let lastMemoKey = $state<string | null>(null);
  $effect(() => {
    if (lastMemoKey !== memoKey) {
      lastMemoKey = memoKey;
      memo = pageId ? defaultSupportMemo(pageTitle) : "";
    }
  });

  let support = $derived(
    buildDirectSupportUri({
      address: recipientAddress,
      amount: zecAmount,
      memo: recipientAcceptsMemo ? memo : "",
    }),
  );
  let zcashUri = $derived(support.uri);
  let memoTooLong = $derived(support.memoTooLong);
  let memoBytes = $derived(support.memoBytes);
  let amountInvalid = $derived(support.amountInvalid);

  function handlePaymentMethodChange(value: string) {
    if (value !== "tuzis" && value !== "zcash") return;

    paymentMethod = value;
    const panel = value === "tuzis" ? tuzisPanel : zcashPanel;
    // Each panel owns its scroll region. Start every newly selected method at
    // its heading instead of carrying a stale offset from the previous visit.
    panel?.scrollTo({ top: 0, behavior: "auto" });
  }

  $effect(() => {
    if (!open || !zcashUri) {
      qrDataUrl = null;
      qrError = false;
      return;
    }

    qrError = false;
    QRCode.toDataURL(zcashUri, {
      margin: 1,
      width: 240,
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then((url: string) => {
        qrDataUrl = url;
      })
      .catch(() => {
        qrDataUrl = null;
        qrError = true;
      });
  });

  function copyValueFallback(value: string) {
    const textarea = document.createElement("textarea");
    const previouslyFocused = document.activeElement as HTMLElement | null;

    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, value.length);

    try {
      return document.execCommand("copy");
    } finally {
      textarea.remove();
      previouslyFocused?.focus();
    }
  }

  async function copyValue(value: string, success: string) {
    const operationNotice = captureAccountToast();
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(value);
    } catch (clipboardError) {
      try {
        if (!copyValueFallback(value)) throw clipboardError;
      } catch {
        operationNotice.error(
          $t("pageActions.donate.copyFailed", "Copy failed"),
        );
        return;
      }
    }

    copied = true;
    operationNotice.success(success);
    clearTimeout(copiedResetTimeout);
    copiedResetTimeout = setTimeout(() => (copied = false), 3000);
  }

  async function handleDonateTuzis() {
    const preflightActor = $currentUser?.id ?? $currentUser?.username;
    const authenticationOwner = authStore.captureRequestOwnership();
    const ownsPreflight =
      preflightActor !== undefined ? authenticationOwner : () => true;
    let operationNotice = captureAccountToast({
      onError: (message) => {
        if (requestGeneration !== dialogGeneration) return;
        paymentError = {
          message: String(message),
          generation: $toastPresentation.generation,
        };
      },
    });
    // Take the submit lock SYNCHRONOUSLY, before the first await. The button's
    // `disabled={sending}` cannot guard an await that runs before the flag is
    // set: two fast clicks during `ensureAuthenticated()` would both fall
    // through validation and both POST to /api/tuzis/donate/, which is not
    // idempotent — the user is debited twice.
    if (sending) return;
    sending = true;
    paymentError = null;
    insufficientFunds = null;
    // The controls remain editable while authentication/CSRF and the POST are
    // in flight. Capture the submitted values before the first await so a
    // later checkbox or amount change cannot make the request and receipt
    // describe different payments.
    const submittedAmount = donationAmount;
    const submittedAnonymous = anonymous;
    const submittedCreatorId = creator.id;
    const submittedCreatorUsername = creator.username;
    const submittedPageTitle = pageTitle;
    const submittedPageId = pageId;
    const submittedPageAddress = pageAddress;
    const requestGeneration = dialogGeneration;
    try {
      const authenticated = await authStore.ensureAuthenticated();
      if (destroyed) return;
      if (!ownsPreflight()) {
        if (!destroyed && authenticationOwner.wasExpired?.()) {
          operationNotice.error(
            $t("economy.signInAgain", "Sign in again before continuing."),
          );
        }
        return;
      }
      if (!authenticated || !$currentUser) {
        if (requestGeneration === dialogGeneration) {
          operationNotice.error("Please log in to support this creator.");
        }
        return;
      }
      operationNotice = captureAccountToast({
        onError: (message) => {
          if (requestGeneration !== dialogGeneration) return;
          paymentError = {
            message: String(message),
            generation: $toastPresentation.generation,
          };
        },
      });
      // The payer is read only AFTER authentication resolved.
      // During hydration `$currentUser` is null; a key minted before this
      // point would sit in a different retry bucket from the one the hydrated
      // retry reads, and the storage name carries the payer because
      // localStorage is per browser, not per account — two accounts sharing
      // one key means one account's success erases the other's only proof
      // that a charge may already have happened.
      const paymentIdentity = {
        actor: $currentUser.username,
        creator: submittedCreatorUsername,
        amount: String(submittedAmount),
        anonymous: submittedAnonymous,
        intent: "donation",
      };
      const idempotencyKey = donationIdempotencyKey(paymentIdentity);
      if (!Number.isInteger(submittedAmount) || submittedAmount < 1) {
        if (requestGeneration === dialogGeneration) {
          operationNotice.error(
            "Choose a whole-number amount of at least 1 2Z.",
          );
        }
        return;
      }
      if (compareDecimalText(balance, String(submittedAmount)) < 0) {
        if (requestGeneration === dialogGeneration) {
          insufficientFunds = makeInsufficientFunds(
            submittedAmount,
            balance,
            "donation",
          );
        }
        return;
      }

      const result = await tuzisDonateIdempotentCreate(
        submittedCreatorUsername,
        {
          amount: String(submittedAmount),
          anon: submittedAnonymous,
          intent: "donation",
        },
        { headers: { "Idempotency-Key": idempotencyKey } },
      );
      if (!operationNotice.isCurrent()) return;
      let storageCleanupFailed = false;
      try {
        clearDonationIdempotencyKey(paymentIdentity, {
          expectedKey: idempotencyKey,
        });
      } catch (error) {
        if (!isIdempotencyStorageCleanupFailure(error)) throw error;
        storageCleanupFailed = true;
      }

      // The route component is retained while a zPage navigation completes.
      // The request still settles, but its receipt and toast belong to the
      // page that submitted it, never to the destination page.
      const stillOnSubmittedPage =
        creator.id === submittedCreatorId &&
        pageId === submittedPageId &&
        pageAddress === submittedPageAddress;
      const dialogStillShowsSubmittedPage =
        requestGeneration === dialogGeneration &&
        stillOnSubmittedPage &&
        operationNotice.isCurrent();
      if (dialogStillShowsSubmittedPage) {
        receipt = {
          amount: submittedAmount,
          anonymous: submittedAnonymous,
          recipient: submittedCreatorUsername,
          pageTitle: submittedPageTitle,
        };
      }
      operationNotice.success(
        result.replayed
          ? $t(
              "pageActions.donate.alreadyRecorded",
              "This usage-credit transfer was already recorded.",
            )
          : submittedAnonymous
            ? $t(
                "pageActions.donate.successAnonymous",
                "Shared {amount} 2Z usage credits with {username} with your username hidden!",
                {
                  amount: submittedAmount,
                  username: submittedCreatorUsername,
                },
              )
            : $t(
                "pageActions.donate.success",
                "Shared {amount} 2Z usage credits with {username}!",
                {
                  amount: submittedAmount,
                  username: submittedCreatorUsername,
                },
              ),
      );
      if (storageCleanupFailed) {
        operationNotice.error(
          $t(
            "payments.storageCleanup",
            "Browser storage could not save this outcome. Check the request's outcome before retrying.",
          ),
        );
      }
      await authStore.checkAuth({ force: true, silent: true });
    } catch (error: any) {
      if (isIdempotencyStorageUnavailable(error)) {
        operationNotice.error(
          $t(
            "payments.storageUnavailable",
            "Browser storage is unavailable. Restore it and check any previous payment before retrying. This attempt was not sent.",
          ),
        );
        return;
      }
      const details = insufficientFundsFromError(error);
      if (
        details &&
        requestGeneration === dialogGeneration &&
        operationNotice.isCurrent()
      ) {
        insufficientFunds = details;
        return;
      }
      operationNotice.error(error?.message || "Support payment failed");
    } finally {
      // Closing or navigating away must not release the submit lock while the
      // original charge can still settle. There is only one request at a time,
      // so the request that owns the lock also owns its release.
      sending = false;
      if (
        requestGeneration !== dialogGeneration ||
        creator.id !== submittedCreatorId ||
        pageId !== submittedPageId ||
        pageAddress !== submittedPageAddress
      ) {
        anonymous = false;
      }
    }
  }

  function resetDialog() {
    dialogGeneration += 1;
    // A close is only a visibility change while a payment is in flight. Keep
    // the lock and the submitted identity intact until the response settles;
    // otherwise close/reopen can mint a second key and charge twice.
    receipt = null;
    insufficientFunds = null;
    paymentError = null;
    if (!sending) anonymous = false;
    paymentMethod = "tuzis";
    copied = false;
    // A memo draft lives only as long as the dialog is open.
    memo = pageId ? defaultSupportMemo(pageTitle) : "";
    clearTimeout(copiedResetTimeout);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) resetDialog();
    open = nextOpen;
  }
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <Dialog.Trigger
    aria-label={triggerLabel}
    title={triggerLabel}
    class={buttonVariants({
      variant: triggerVariant,
      class: `gap-2 ${triggerClass}`,
    })}
  >
    <HeartHandshake class="size-4 shrink-0" strokeWidth={1.75} />
    {#if triggerIconOnly}
      <span class="sr-only">{triggerLabel}</span>
    {:else}
      <span>{triggerLabel}</span>
    {/if}
  </Dialog.Trigger>

  <Dialog.Content
    class={`sm:max-w-[460px] ${
      receipt
        ? "max-h-[calc(100dvh-2rem)] overflow-y-auto"
        : "flex h-[calc(100dvh-2rem)] max-h-[720px] flex-col overflow-hidden pb-[max(1.5rem,env(safe-area-inset-bottom))]"
    }`}
  >
    {#if paymentError}
      <p
        role="alert"
        data-testid="payment-outcome-error"
        class="rounded-md border border-destructive/40 p-3 text-sm text-destructive"
      >
        {paymentError.message}
      </p>
    {/if}
    {#if receipt}
      <Dialog.Header>
        <Dialog.Title
          >{$t(
            "pageActions.donate.usageSent",
            "Usage credits sent",
          )}</Dialog.Title
        >
        <Dialog.Description>
          {$t(
            "pageActions.donate.usageReceipt",
            "Usage credits were delivered to {username}. USD earnings are separate.",
            { username: receipt.recipient },
          )}
        </Dialog.Description>
      </Dialog.Header>
      <div class="flex flex-col items-center py-6 text-center">
        <CircleCheck class="mb-4 size-12 text-primary" />
        <p class="text-3xl font-bold tabular-nums">{receipt.amount} 2Z</p>
        <p class="mt-2 max-w-xs text-sm text-muted-foreground">
          {#if receipt.pageTitle}
            Supporting “{receipt.pageTitle}”
          {:else}
            Supporting @{receipt.recipient}
          {/if}
        </p>
        {#if receipt.anonymous}
          <p
            class="mt-3 inline-flex items-center gap-2 text-xs text-muted-foreground"
          >
            <ShieldCheck class="size-4" />
            {$t(
              "pageActions.donate.usernameHiddenReceipt",
              "Your Free2Z username was hidden from the creator.",
            )}
          </p>
        {/if}
      </div>
      <Dialog.Close
        class={buttonVariants({ variant: "default", class: "w-full" })}
      >
        Done
      </Dialog.Close>
    {:else}
      <Dialog.Header class="shrink-0 pr-6">
        <Dialog.Title>Support {creator.username}</Dialog.Title>
        <Dialog.Description>
          {$t(
            "pageActions.donate.supportChoice",
            "Share 2Z usage credits or send Zcash directly from your wallet.",
          )}
        </Dialog.Description>
      </Dialog.Header>

      <Tabs.Root
        bind:value={paymentMethod}
        onValueChange={handlePaymentMethodChange}
        class="min-h-0 flex-1 gap-4 overflow-hidden"
      >
        <Tabs.List class="grid w-full shrink-0 grid-cols-2">
          <Tabs.Trigger value="tuzis">2Z</Tabs.Trigger>
          <Tabs.Trigger value="zcash">Zcash</Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content
          bind:ref={tuzisPanel}
          value="tuzis"
          class="min-h-0 space-y-5 overflow-y-auto overscroll-contain pr-1"
        >
          <div class="flex items-center gap-3 rounded-lg bg-muted/60 p-3">
            <Coins class="size-5 text-primary" />
            <p class="text-sm">
              Send platform credits directly to
              <span class="font-semibold">@{creator.username}</span>.
            </p>
          </div>

          <div class="space-y-3">
            <Label for="support-amount">Amount</Label>
            <div class="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon-lg"
                aria-label="Decrease support amount"
                onclick={() =>
                  (donationAmount = Math.max(1, donationAmount - 1))}>−</Button
              >
              <Input
                id="support-amount"
                type="number"
                bind:value={donationAmount}
                min="1"
                step="1"
                class="h-10 text-center text-lg font-semibold tabular-nums"
              />
              <Button
                variant="outline"
                size="icon-lg"
                aria-label="Increase support amount"
                onclick={() => (donationAmount += 1)}>+</Button
              >
            </div>
            <div class="grid grid-cols-4 gap-2">
              {#each quickAmounts as amount}
                <Button
                  variant={donationAmount === amount ? "secondary" : "outline"}
                  size="sm"
                  onclick={() => (donationAmount = amount)}>{amount} 2Z</Button
                >
              {/each}
            </div>
          </div>

          <Separator />

          {#if user}
            <div class="flex items-center justify-between text-sm">
              <span class="text-muted-foreground">Your balance</span>
              <span
                class:!text-destructive={!canAfford}
                class="font-medium tabular-nums"
              >
                {formatDecimalText(balance, $locale)} 2Z
              </span>
            </div>
            <div class="flex items-start gap-3 rounded-md bg-muted/40 p-3">
              <Checkbox
                id="support-anonymous"
                bind:checked={anonymous}
                disabled={sending}
              />
              <div class="space-y-1">
                <Label for="support-anonymous"
                  >{$t(
                    "pageActions.donate.anonymousLabel",
                    "Hide your username",
                  )}</Label
                >
                <p class="text-xs text-muted-foreground">
                  {$t(
                    "pageActions.donate.anonymousHint",
                    "Hide your username from {username}",
                    { username: creator.username },
                  )}
                </p>
              </div>
            </div>

            {#if insufficientFunds || !canAfford}
              <InsufficientFunds
                funds={insufficientFunds ??
                  makeInsufficientFunds(donationAmount, balance, "donation")}
              />
            {/if}
            {#if canAfford}
              <Button
                class="h-11 w-full"
                disabled={sending}
                aria-busy={sending}
                onclick={handleDonateTuzis}
                >{sending
                  ? "Sending…"
                  : insufficientFunds
                    ? $t(
                        "pageActions.donate.retryUsage",
                        "Retry credit transfer",
                      )
                    : $t("pageActions.donate.shareUsage", "Share {amount} 2Z", {
                        amount: donationAmount,
                      })}</Button
              >
            {/if}
          {:else}
            <!-- In place: the donate dialog is a state of THIS page,
                 and a navigation would have thrown it away. -->
            <Button
              href={loginDestination($page.url.pathname + $page.url.search)}
              class="h-11 w-full"
              data-testid="donate-login-prompt"
              onclick={(e) => {
                e.preventDefault();
                requestLogin({ trigger: e.currentTarget });
              }}
              >{$t("profile.donate.logInToSend", "Log in to share 2Zs")}</Button
            >
          {/if}
        </Tabs.Content>

        <Tabs.Content
          bind:ref={zcashPanel}
          value="zcash"
          class="min-h-0 space-y-5 overflow-y-auto overscroll-contain pr-1"
        >
          {#if recipientAddress}
            <div class="space-y-2 rounded-lg bg-muted/60 p-3">
              <p class="text-sm">
                {#if pageId && pageTitle}
                  {$t(
                    "pageActions.donate.recipientPage",
                    "Paying the support address for “{title}” by @{username}.",
                    { title: pageTitle, username: creator.username },
                  )}
                {:else}
                  {$t(
                    "pageActions.donate.recipientCreator",
                    "Paying @{username} directly.",
                    { username: creator.username },
                  )}
                {/if}
              </p>
              <div class="flex items-start gap-2">
                <code
                  data-testid="zec-recipient-address"
                  class="min-w-0 flex-1 rounded-md bg-background/80 px-2 py-1.5 font-mono text-[11px] leading-snug break-all select-all"
                  >{recipientAddress}</code
                >
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={$t(
                    "pageActions.donate.copyAddress",
                    "Copy Zcash address",
                  )}
                  onclick={() =>
                    copyValue(
                      recipientAddress,
                      $t(
                        "pageActions.donate.copied",
                        "Address copied to clipboard",
                      ),
                    )}
                >
                  <Copy class="size-4" />
                </Button>
              </div>
              <p class="text-xs text-muted-foreground">
                {$t(
                  "pageActions.donate.verifyRecipient",
                  "Check this address matches the one your wallet shows before sending.",
                )}
              </p>
            </div>

            <div class="mx-auto w-fit rounded-lg bg-white p-3">
              {#if qrDataUrl}
                <img
                  src={qrDataUrl}
                  alt="Zcash payment QR code"
                  width="200"
                  height="200"
                  class="block size-[200px]"
                />
              {:else if qrError}
                <div
                  class="flex size-[200px] items-center justify-center text-center text-sm text-destructive"
                >
                  QR code unavailable
                </div>
              {:else}
                <div
                  class="size-[200px] animate-pulse rounded-md bg-zinc-100"
                ></div>
              {/if}
            </div>

            <div class="space-y-2">
              <Label for="zec-support-amount">Amount in ZEC (optional)</Label>
              <!-- Text, not number: a number input hands Svelte a JS number, and
                   `0.00000001` becomes `1e-8`, which is not a ZIP 321 amount. The
                   supporter's decimal text goes to the wallet verbatim. -->
              <Input
                id="zec-support-amount"
                type="text"
                inputmode="decimal"
                autocomplete="off"
                bind:value={zecAmount}
                aria-invalid={amountInvalid || undefined}
                aria-describedby={amountInvalid
                  ? "zec-support-amount-error"
                  : undefined}
                placeholder="0.00"
              />
              {#if amountInvalid}
                <p
                  id="zec-support-amount-error"
                  class="text-xs text-destructive"
                >
                  {$t(
                    "pageActions.donate.amountInvalid",
                    "Enter a ZEC amount like 0.25 (up to 8 decimal places), or leave it blank.",
                  )}
                </p>
              {/if}
            </div>

            {#if recipientAcceptsMemo}
              <div class="space-y-2">
                <div class="flex items-baseline justify-between gap-2">
                  <Label for="zec-support-memo"
                    >{$t(
                      "pageActions.donate.memoLabel",
                      "Memo to the creator (optional)",
                    )}</Label
                  >
                  <span
                    data-testid="zec-memo-bytes"
                    class={`text-xs tabular-nums ${memoTooLong ? "text-destructive" : "text-muted-foreground"}`}
                    >{memoBytes} / {ZCASH_MEMO_MAX_BYTES}</span
                  >
                </div>
                <Textarea
                  id="zec-support-memo"
                  bind:value={memo}
                  rows={2}
                  aria-invalid={memoTooLong || undefined}
                  aria-describedby="zec-support-memo-hint"
                />
                <p
                  id="zec-support-memo-hint"
                  class={`text-xs ${memoTooLong ? "text-destructive" : "text-muted-foreground"}`}
                >
                  {#if memoTooLong}
                    {$t(
                      "pageActions.donate.memoTooLong",
                      "Shorten the memo: Zcash memos hold at most {max} bytes.",
                      { max: ZCASH_MEMO_MAX_BYTES },
                    )}
                  {:else}
                    {$t(
                      "pageActions.donate.memoHint",
                      "Only the creator’s wallet can read this. Free2Z does not see it. Clear it to send no memo.",
                    )}
                  {/if}
                </p>
              </div>
            {:else}
              <p class="text-xs text-muted-foreground">
                {$t(
                  "pageActions.donate.transparentNoMemo",
                  "This is a transparent address, so the payment carries no memo.",
                )}
              </p>
            {/if}

            <div class="flex gap-2">
              <Button
                href={zcashUri || undefined}
                disabled={!zcashUri}
                data-testid="zec-open-wallet"
                class="flex-1"
              >
                <ExternalLink class="size-4" />
                {$t("pageActions.donate.openWallet", "Open wallet")}
              </Button>
              <Button
                variant="outline"
                size="icon-lg"
                disabled={!zcashUri}
                aria-label={$t(
                  "pageActions.donate.copyPaymentLink",
                  "Copy Zcash payment link",
                )}
                onclick={() =>
                  copyValue(
                    zcashUri,
                    $t(
                      "pageActions.donate.paymentLinkCopied",
                      "Payment link copied",
                    ),
                  )}
              >
                {#if copied}<Check class="size-4" />{:else}<Copy
                    class="size-4"
                  />{/if}
              </Button>
            </div>

            <div
              class="space-y-1 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground"
            >
              <p>
                {$t(
                  "pageActions.donate.directNote",
                  "This goes straight from your wallet to the creator’s. Free2Z is not part of the payment and does not process the memo.",
                )}
              </p>
              <p>
                {$t(
                  "pageActions.donate.buy2zNote",
                  "Want to boost or comment instead? Those use 2Z platform credits, which you can buy with Zcash in Credits & Earnings.",
                )}
              </p>
            </div>
          {:else}
            <div class="py-8 text-center">
              <Wallet class="mx-auto mb-3 size-8 text-muted-foreground" />
              <p class="font-medium">No Zcash address configured</p>
              <p class="mt-1 text-sm text-muted-foreground">
                You can still support this creator with 2Z.
              </p>
            </div>
          {/if}
        </Tabs.Content>
      </Tabs.Root>
    {/if}
  </Dialog.Content>
</Dialog.Root>
