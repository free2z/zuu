<script lang="ts">
  /**
   * Report a comment, zPage or account to Free2Z staff.
   *
   * One dialog for every entry point. The reason list leads with child
   * sexual abuse or exploitation because Play's Child Safety Standards
   * require that report path to be findable, and staff are paged for it.
   * It never asks for images or attachments: a reporter must not be told
   * to collect or upload suspected abuse material.
   */
  import { toast, captureAccountToast } from "$lib/toast.js";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Label } from "$lib/components/ui/label";
  import { Textarea } from "$lib/components/ui/textarea";
  import { authStore } from "$lib/stores/auth";
  import { requestLogin } from "$lib/stores/auth-modal";
  import { tStore as t } from "$lib/i18n";
  import {
    REPORT_DETAILS_MAX,
    REPORT_REASONS,
    submitReport,
    type ReportReason,
    type ReportTargetKind,
  } from "$lib/moderation";

  let {
    open = $bindable(false),
    kind,
    targetId,
  }: {
    open?: boolean;
    kind: ReportTargetKind;
    /** comment UUID, zPage free2zaddr, or creator username. */
    targetId: string;
  } = $props();

  let reason = $state<ReportReason | "">("");
  let details = $state("");
  let submitting = $state(false);
  let error = $state("");

  const reasonLabels: Record<ReportReason, [string, string]> = {
    csae: [
      "moderation.report.reasons.csae",
      "Child sexual abuse or exploitation",
    ],
    harassment: [
      "moderation.report.reasons.harassment",
      "Harassment or threats",
    ],
    hate: ["moderation.report.reasons.hate", "Hateful content"],
    sexual: ["moderation.report.reasons.sexual", "Sexual content"],
    violence: ["moderation.report.reasons.violence", "Violence"],
    spam: ["moderation.report.reasons.spam", "Spam or scam"],
    other: ["moderation.report.reasons.other", "Something else"],
  };

  const titles: Record<ReportTargetKind, [string, string]> = {
    comment: ["moderation.report.titleComment", "Report comment"],
    zpage: ["moderation.report.titleZpage", "Report page"],
    creator: ["moderation.report.titleCreator", "Report account"],
  };

  function reset() {
    reason = "";
    details = "";
    error = "";
    submitting = false;
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
  }

  async function submit(event: SubmitEvent) {
    const operationNotice = captureAccountToast();
    event.preventDefault();
    if (!reason || submitting) return;
    submitting = true;
    error = "";
    const authenticated = await authStore.ensureAuthenticated();
    if (!authenticated) {
      submitting = false;
      open = false;
      reset();
      requestLogin();
      return;
    }
    const outcome = await submitReport({
      kind,
      targetId,
      reason,
      details,
    });
    submitting = false;
    if (outcome.ok) {
      open = false;
      reset();
      operationNotice.success(
        $t(
          "moderation.report.submitted",
          "Thanks. Your report was sent to the Free2Z team for review.",
        ),
      );
      return;
    }
    switch (outcome.reason) {
      case "auth":
        open = false;
        reset();
        requestLogin();
        return;
      case "rate":
        error = $t(
          "moderation.report.rateLimited",
          "You have sent a lot of reports recently. Please try again later.",
        );
        return;
      case "gone":
        error = $t(
          "moderation.report.gone",
          "This content is no longer available to report.",
        );
        return;
      case "invalid":
        error =
          outcome.message ||
          $t(
            "moderation.report.failed",
            "The report could not be sent. Please try again.",
          );
        return;
      default:
        error = $t(
          "moderation.report.failed",
          "The report could not be sent. Please try again.",
        );
    }
  }
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <Dialog.Content
    class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
    data-testid="report-dialog"
  >
    <Dialog.Header>
      <Dialog.Title>{$t(titles[kind][0], titles[kind][1])}</Dialog.Title>
      <Dialog.Description>
        {$t(
          "moderation.report.description",
          "Reports are private. The Free2Z team reviews them; the account you report is not told who reported it.",
        )}
      </Dialog.Description>
    </Dialog.Header>

    <form class="space-y-4" onsubmit={submit}>
      <fieldset class="space-y-1">
        <legend class="mb-2 text-sm font-medium">
          {$t("moderation.report.reasonLegend", "What is wrong with it?")}
        </legend>
        {#each REPORT_REASONS as value (value)}
          <label
            class="flex cursor-pointer items-start gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50"
          >
            <input
              type="radio"
              name="report-reason"
              {value}
              bind:group={reason}
              class="mt-0.5 cursor-pointer accent-primary"
              data-testid={`report-reason-${value}`}
            />
            <span>{$t(reasonLabels[value][0], reasonLabels[value][1])}</span>
          </label>
        {/each}
      </fieldset>

      {#if reason === "csae"}
        <p
          class="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
          data-testid="report-csae-notice"
        >
          {$t(
            "moderation.report.csaeNotice",
            "Do not download, screenshot or share the material. If a child is in immediate danger, contact local law enforcement now. Free2Z staff are alerted to these reports and handle them first.",
          )}
        </p>
      {/if}

      <div class="space-y-2">
        <Label for="report-details">
          {$t("moderation.report.detailsLabel", "Details (optional)")}
        </Label>
        <Textarea
          id="report-details"
          bind:value={details}
          maxlength={REPORT_DETAILS_MAX}
          rows={3}
          placeholder={$t(
            "moderation.report.detailsPlaceholder",
            "Anything that helps the team understand the problem. Do not paste or attach images.",
          )}
        />
      </div>

      {#if error}
        <p class="text-sm text-destructive" role="alert">{error}</p>
      {/if}

      <Dialog.Footer class="sm:flex-row">
        <Button
          type="button"
          variant="outline"
          onclick={() => {
            open = false;
            reset();
          }}>{$t("common.cancel", "Cancel")}</Button
        >
        <Button
          type="submit"
          disabled={!reason || submitting}
          data-testid="report-submit"
        >
          {submitting
            ? $t("moderation.report.sending", "Sending…")
            : $t("moderation.report.submit", "Send report")}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
