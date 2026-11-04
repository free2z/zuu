<script lang="ts">
  /**
   * "Translate with AI" — the confirmation that shows the price ( §6.1).
   *
   * The one rule this component exists to hold: **no 2Z can be committed from
   * a screen that has not shown the number.** Pricing is cost-plus and
   * metered, so there is no price list to look it up in — the quote endpoint
   * is the only place the figure exists, and a creator who has not seen it has
   * not agreed to it. That is why the confirm button does not render at all
   * until `quote` has arrived, rather than rendering disabled next to a
   * spinner: a button that is about to become clickable invites a click at
   * whatever price lands under the cursor.
   *
   * The dialog is presentational. It quotes nothing, buys nothing and polls
   * nothing; the editor page owns every call, because every call has to
   * coordinate with the autosave clock.
   *
   * **A price, a promise, a button**. It used to open with five
   * paragraphs, two of which explained the mechanics of a load-or-keep choice
   * that no longer exists and of a source-selection rule the purchase path now
   * guarantees. Both are gone: `openTranslateWithAi` flushes the canonical
   * article before quoting and refuses to quote if that save fails, so "AI
   * translates the SAVED original" is a fact about the code rather than a
   * caveat for the creator to hold in their head. Explaining a footgun is
   * worse than removing it.
   *
   * **2Z are Free2Z credits, never money and never cryptocurrency.** That is a
   * compliance constraint on this screen, not a matter of tone, which is why
   * the credits framing stays on the balance line however short this gets.
   */
  import { tStore as t } from "$lib/i18n";
  import { currentUser, authStore } from "$lib/stores/auth";
  import { createQuotedBalanceDisplay } from "$lib/account-balance";
  import type { TranslationQuote } from "$lib/api/f2z.schemas";
  import InsufficientFunds from "$lib/components/InsufficientFunds.svelte";
  import {
    compareDecimalText,
    makeInsufficientFunds,
    type InsufficientFundsDetails,
  } from "$lib/insufficient-funds";

  function focusOnMount(node: HTMLElement) {
    node.focus();
  }

  function modalFocus(node: HTMLElement) {
    const previous = document.activeElement as HTMLElement | null;
    const buttons = () =>
      Array.from(
        node.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      );
    queueMicrotask(() => buttons()[0]?.focus());
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const available = buttons();
      const first = available[0];
      const last = available.at(-1);
      if (!first) {
        event.preventDefault();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !node.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !node.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    node.addEventListener("keydown", trap);
    return {
      destroy() {
        node.removeEventListener("keydown", trap);
        previous?.focus();
      },
    };
  }

  interface Props {
    open: boolean;
    owner?: { username: string; id?: number };
    /** Display name of the target language, already localized. */
    language: string;
    /** The quote, once it has arrived. `null` while it is being fetched. */
    quote: TranslationQuote | null;
    /** A refusal from the quote, already turned into a sentence. */
    error: string | null;
    /** A purchase outcome keeps the exact quoted retry available. */
    purchaseError?: string | null;
    replaying?: boolean;
    /** Structured balance refusal, when the quote or purchase was unaffordable. */
    insufficientFunds: InsufficientFundsDetails | null;
    /** True from the click on the confirm button until the 202 (or refusal). */
    buying: boolean;
    onretry?: () => void;
    onconfirm: () => void;
    onclose: () => void;
  }

  let {
    open,
    owner,
    language,
    quote,
    error,
    purchaseError = null,
    replaying = false,
    insufficientFunds,
    buying,
    onretry,
    onconfirm,
    onclose,
  }: Props = $props();

  const quotedBalance = createQuotedBalanceDisplay((owner, order, balance) => {
    if (typeof window !== "undefined" && owner) {
      authStore.fenceAccountSnapshot(owner.username, order);
      // Dispatch order cannot establish when the database read occurred.
      authStore.observeAccountBalanceSnapshot({
        username: owner.username,
        id: owner.id,
        tuzis: balance,
      });
    }
  });
  const displayBalance = $derived(quotedBalance(quote, owner, $currentUser));
  const balanceChanged = $derived(
    Boolean(quote) &&
      compareDecimalText(displayBalance, quote?.balance ?? "0") !== 0,
  );

  const affordable = $derived(
    quote
      ? !insufficientFunds &&
          quote.affordable &&
          compareDecimalText(quote.balance, quote.price) >= 0
      : false,
  );
</script>

{#if open}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
  >
    <div
      use:modalFocus
      role="dialog"
      aria-modal="true"
      aria-labelledby="translate-ai-title"
      aria-describedby="translate-ai-body"
      class="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-lg border border-border bg-background p-5 shadow-lg"
      data-testid="translate-ai-dialog"
    >
      <h2 id="translate-ai-title" class="text-lg font-semibold">
        {$t("editor.translateAiTitle", "Translate into {language}", {
          language,
        })}
      </h2>

      <div id="translate-ai-body" class="mt-3 space-y-2 text-sm">
        {#if purchaseError}
          <p
            role="alert"
            class="text-destructive"
            data-testid="translate-ai-purchase-error"
          >
            {purchaseError}
          </p>
        {/if}
        {#if insufficientFunds}
          <InsufficientFunds {owner} funds={insufficientFunds} />
        {:else if error}
          <p
            class="text-destructive"
            role="alert"
            data-testid="translate-ai-error"
          >
            {error}
          </p>
        {:else if quote}
          <p
            class="text-2xl font-semibold text-foreground"
            data-testid="translate-ai-price"
          >
            {$t("editor.translateAiPrice", "{price} 2Z", {
              price: quote.price,
            })}
          </p>
          <!--
            "Free2Z credits" is not filler. 2Z are platform credits and must
            never read as money or cryptocurrency; that framing stays on this
            line however short the dialog gets.
          -->
          <p class="text-xs text-muted-foreground">
            {$t(
              "editor.translateAiBalance",
              "Balance {balance} 2Z · Free2Z credits",
              { balance: displayBalance },
            )}
          </p>
          <p>
            {$t(
              "editor.translateAiDraftNotice",
              // THE TERMS, AND THEY HAVE TO BE TRUE.
              //
              // This dialog's whole job is that no 2Z is committed from a
              // screen that has not shown the number and said what happens to
              // it.  introduced one exception to "your 2Z come straight
              // back" — repeatedly changing the article while a job you have
              // already paid for is running — so the promise on this screen had
              // to change with it. A creator who reads an unconditional promise
              // and is then charged was not told the terms; the codex
              // adversarial review of  caught exactly that.
              //
              // It is still unconditional for every failure that is ours or the
              // provider's, which is what nearly every failure is, and the
              // behaviour a creator has to avoid is one they control.
              // folded the old separate `translateAiRefundNotice` into this
              // line, so this is where the promise lives now.
              //
              // It must name the WHOLE chargeable set, not the easiest example
              // of it. `settlement.FAULT_BY_CODE`'s REQUESTER_ACTION entries
              // are: editing the article (`source_changed`), relabelling its
              // language (`same_language`), and editing or publishing the
              // translation (`variant_changed`, `variant_published`). An
              // earlier draft said only "changing the article", which left
              // publishing the translation — the free-cancel route this issue
              // closed — unnamed on the one screen that asks for consent.
              // (Reviewer of, finding 3.) Deleting the article and an
              // ownership change are NOT in the set: we cannot tell those from
              // a moderation action, so they refund in full.
              "You'll get a draft in a few minutes, yours to read and edit before publishing. If it fails, your 2Z come straight back — unless you keep changing this article, or changing or publishing its translation, while it runs. Then the work already done is charged for, never more than the {price} 2Z above.",
              { price: quote.price },
            )}
          </p>
          {#if quote.existing_variant}
            <!--
              There is already an unpublished draft in this language and the
              purchase will replace it. Saying so is not decoration: the editor
              stops watching a long job, so a creator can be looking at a price
              screen for a language whose translation quietly arrived. Buying
              again is a legitimate choice — re-translating after an edit — but
              it has to be a choice, not a surprise.
            -->
            <p
              class="text-amber-600 dark:text-amber-400"
              data-testid="translate-ai-replaces"
            >
              {$t(
                "editor.translateAiReplacesDraft",
                "This replaces the saved {language} draft.",
                { language },
              )}
            </p>
          {/if}
          <p class="text-xs text-muted-foreground">
            {$t(
              "editor.translateAiModelNotice",
              "Translated by {model}, and labelled as machine-made. Never published for you.",
              { model: quote.ai_model },
            )}
          </p>
          {#if !affordable}
            <InsufficientFunds
              {owner}
              funds={makeInsufficientFunds(
                quote.price,
                displayBalance,
                "translation",
              )}
            />
          {/if}
        {:else}
          <p class="text-muted-foreground" data-testid="translate-ai-quoting">
            {$t("editor.translateAiQuoting", "Working out the price…")}
          </p>
        {/if}
      </div>

      <div class="mt-5 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          class="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          onclick={onclose}
          disabled={buying}
        >
          {$t("common.cancel", "Cancel")}
        </button>
        <!--
          Rendered only once there IS a price. See the note at the top: the
          confirm action and the number it commits to appear together or not at
          all.
        -->
        {#if (error || insufficientFunds || (quote && !affordable) || balanceChanged) && onretry}
          <button
            type="button"
            onclick={onretry}
            disabled={buying}
            class="rounded-md border border-border px-3 py-1.5 text-sm"
            >{$t(
              "editor.translateRetryQuote",
              "Refresh price and balance",
            )}</button
          >
        {/if}
        {#if quote && !error && !insufficientFunds && affordable}
          <button
            type="button"
            use:focusOnMount
            class="rounded-md bg-primary px-3 py-1.5 text-sm text-white hover:bg-primary/90 disabled:opacity-50"
            onclick={onconfirm}
            disabled={buying}
            data-testid="translate-ai-confirm"
          >
            {buying
              ? $t("editor.translateAiBuying", "Starting…")
              : replaying && purchaseError
                ? $t(
                    "editor.translationRecoverPurchase",
                    "Recover translation purchase",
                  )
                : $t("editor.translateAiConfirm", "Translate for {price} 2Z", {
                    price: quote.price,
                  })}
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}
