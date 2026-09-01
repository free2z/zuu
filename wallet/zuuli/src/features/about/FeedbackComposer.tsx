import { useEffect, useId, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AlertTriangle, Check, Copy, ExternalLink, Mail, MessagesSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  FEEDBACK_DESCRIPTION_LIMIT,
  buildFeedbackHandoffUrl,
  captureFeedbackDiagnostics,
  createFeedbackDraft,
  feedbackDraftText,
  reviewFeedbackDraft,
  type FeedbackChannel,
  type FeedbackDraft,
} from "@/lib/feedback";
import { isTauri } from "@/lib/platform";
import {
  resolveAboutMessages,
  type AboutMessages,
} from "@/lib/about-copy";

type FeedbackStage = "compose" | "preview";
type FeedbackNotice =
  | "copied"
  | "copy-failed"
  | "handoff-failed"
  | "handoff-opened"
  | "scrubbed"
  | "too-long"
  | null;

export type FeedbackComposerProps = Readonly<{
  minimalBuildBlock: string;
  messages?: AboutMessages;
  openExternal?: (url: string) => Promise<void>;
  copyText?: (text: string) => Promise<void>;
}>;

async function defaultOpenExternal(url: string): Promise<void> {
  if (isTauri()) {
    await openUrl(url);
    return;
  }
  if (!navigator.onLine && /^https?:/u.test(url)) {
    throw new Error("Browser is offline");
  }
  // `noopener` deliberately makes Chromium return null even when the target
  // opened, so it cannot distinguish success from popup rejection. Open a
  // same-origin blank synchronously, sever its opener immediately, then
  // navigate only the detached context.
  const opened = window.open("about:blank", "_blank");
  if (opened === null) throw new Error("External app handoff was rejected");
  try {
    opened.opener = null;
    opened.location.replace(url);
  } catch (error) {
    opened.close();
    throw error;
  }
}

async function defaultCopyText(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
  await navigator.clipboard.writeText(text);
}

function noticeMessage(notice: FeedbackNotice, messages: AboutMessages) {
  switch (notice) {
    case "copied":
      return messages.feedbackCopiedStatus;
    case "handoff-failed":
      return messages.feedbackHandoffFailure;
    case "copy-failed":
      return messages.feedbackCopyFailure;
    case "handoff-opened":
      return messages.feedbackHandoffStatus;
    case "scrubbed":
      return messages.feedbackScrubbedWarning;
    case "too-long":
      return messages.feedbackTooLongWarning;
    default:
      return "";
  }
}

export function FeedbackComposer({
  minimalBuildBlock,
  messages = resolveAboutMessages(),
  openExternal = defaultOpenExternal,
  copyText = defaultCopyText,
}: FeedbackComposerProps) {
  const channelLegendId = useId();
  const diagnosticsDescriptionId = useId();
  const noticeId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousStageRef = useRef<FeedbackStage>("compose");
  const [stage, setStage] = useState<FeedbackStage>("compose");
  const [channel, setChannel] = useState<FeedbackChannel | null>(null);
  const [description, setDescription] = useState("");
  const [draft, setDraft] = useState<FeedbackDraft>({ subject: "", body: "" });
  const [notice, setNotice] = useState<FeedbackNotice>(null);
  const [busy, setBusy] = useState(false);

  // Deliberately called without a source: arbitrary errors/logs have no route
  // into this feature until a separate allowlist can prove them safe.
  const diagnostics = captureFeedbackDiagnostics();

  useEffect(() => {
    if (previousStageRef.current !== stage) headingRef.current?.focus();
    previousStageRef.current = stage;
  }, [stage]);

  const beginReview = () => {
    if (channel === null || description.trim().length === 0) return;
    const reviewed = createFeedbackDraft(
      description,
      minimalBuildBlock,
      messages.feedbackDefaultSubject,
      messages.feedbackRedactedValue,
    );
    setDraft(reviewed.draft);
    setNotice(reviewed.findings.length > 0 ? "scrubbed" : null);
    setStage("preview");
  };

  const validateVisibleDraft = (): FeedbackDraft | null => {
    const reviewed = reviewFeedbackDraft(
      draft,
      messages.feedbackRedactedValue,
    );
    if (
      reviewed.findings.length > 0 ||
      reviewed.draft.subject !== draft.subject ||
      reviewed.draft.body !== draft.body
    ) {
      setDraft(reviewed.draft);
      setNotice("scrubbed");
      return null;
    }
    return reviewed.draft;
  };

  const copyReviewed = async () => {
    const safeDraft = validateVisibleDraft();
    if (!safeDraft) return;
    setBusy(true);
    try {
      await copyText(
        feedbackDraftText(safeDraft, messages.feedbackCopiedSubjectPrefix),
      );
      setNotice("copied");
    } catch {
      setNotice("copy-failed");
    } finally {
      setBusy(false);
    }
  };

  const continueToApp = async () => {
    const safeDraft = validateVisibleDraft();
    if (!safeDraft || channel === null) return;
    const handoff = buildFeedbackHandoffUrl(
      channel,
      safeDraft,
      messages.feedbackRedactedValue,
    );
    if (handoff.status === "unsafe") {
      setDraft(handoff.draft);
      setNotice("scrubbed");
      return;
    }
    if (handoff.status === "too-long") {
      setNotice("too-long");
      return;
    }
    setBusy(true);
    try {
      await openExternal(handoff.url);
      setNotice("handoff-opened");
    } catch {
      setNotice("handoff-failed");
    } finally {
      setBusy(false);
    }
  };

  if (stage === "preview") {
    return (
      <section className="min-w-0 space-y-5" aria-labelledby="feedback-preview-title" aria-busy={busy}>
        <div className="min-w-0 space-y-1">
          <h2
            ref={headingRef}
            id="feedback-preview-title"
            tabIndex={-1}
            className="max-w-full break-words text-xl font-semibold [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {messages.feedbackPreviewTitle}
          </h2>
          <p className="max-w-full break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {messages.feedbackPreviewDescription}
          </p>
          <p className="max-w-full break-words text-sm font-medium text-foreground [overflow-wrap:anywhere]">
            {channel === "email"
              ? messages.feedbackEmailName
              : messages.feedbackGithubName}
            :{" "}
            {channel === "email"
              ? messages.feedbackEmailPrivacy
              : messages.feedbackGithubPrivacy}
          </p>
        </div>

        {notice ? (
          <Callout
            id={noticeId}
            role={notice === "copied" || notice === "handoff-opened" ? "status" : "alert"}
            aria-live={notice === "copied" || notice === "handoff-opened" ? "polite" : "assertive"}
            tone={notice === "copied" || notice === "handoff-opened" ? "success" : "warning"}
            icon={notice === "copied" || notice === "handoff-opened" ? Check : AlertTriangle}
            className="min-w-0 break-words [overflow-wrap:anywhere]"
          >
            {noticeMessage(notice, messages)}
          </Callout>
        ) : null}

        <div className="min-w-0 space-y-2">
          <Label htmlFor="feedback-subject">
            {messages.feedbackSubjectLabel}
          </Label>
          <Input
            id="feedback-subject"
            className="min-w-0 max-w-full"
            value={draft.subject}
            maxLength={120}
            readOnly={busy}
            aria-describedby={notice ? noticeId : undefined}
            onChange={(event) => {
              setDraft((current) => ({ ...current, subject: event.target.value }));
              setNotice(null);
            }}
          />
        </div>

        <div className="min-w-0 space-y-2">
          <Label htmlFor="feedback-body">{messages.feedbackBodyLabel}</Label>
          <Textarea
            id="feedback-body"
            className="min-h-72 min-w-0 max-w-full resize-y whitespace-pre-wrap font-mono text-xs leading-relaxed"
            value={draft.body}
            maxLength={6_000}
            readOnly={busy}
            aria-describedby={notice ? noticeId : undefined}
            onChange={(event) => {
              setDraft((current) => ({ ...current, body: event.target.value }));
              setNotice(null);
            }}
          />
        </div>

        <div className="min-w-0 space-y-1">
          <Button type="button" variant="outline" disabled aria-describedby="preview-diagnostics-state" className="h-auto min-h-11 max-w-full whitespace-normal break-words [overflow-wrap:anywhere]">
            {messages.feedbackRemoveDiagnosticsAction}
          </Button>
          <p id="preview-diagnostics-state" className="max-w-full break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {messages.feedbackDiagnosticsUnavailable}
          </p>
        </div>

        <div className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <Button type="button" variant="outline" disabled={busy} onClick={() => void copyReviewed()} className="h-auto min-h-11 max-w-full whitespace-normal break-words [overflow-wrap:anywhere]">
            <Copy aria-hidden />
            {messages.feedbackCopyAction}
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => {
            setStage("compose");
            setNotice(null);
          }} className="h-auto min-h-11 max-w-full whitespace-normal break-words [overflow-wrap:anywhere]">
            {messages.feedbackEditAction}
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => {
            setStage("compose");
            setChannel(null);
            setDescription("");
            setDraft({ subject: "", body: "" });
            setNotice(null);
          }} className="h-auto min-h-11 max-w-full whitespace-normal break-words [overflow-wrap:anywhere]">
            {messages.feedbackCancelAction}
          </Button>
          <Button type="button" className="h-auto min-h-11 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] sm:col-span-2" disabled={busy} onClick={() => void continueToApp()}>
            <ExternalLink aria-hidden />
            {messages.feedbackContinueAction}
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="min-w-0 space-y-5" aria-labelledby="feedback-compose-title">
      <div className="min-w-0 space-y-1">
        <h2
          ref={headingRef}
          id="feedback-compose-title"
          tabIndex={-1}
          className="max-w-full break-words text-xl font-semibold [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {messages.feedbackHeading}
        </h2>
        <p className="max-w-full break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">
          {messages.feedbackDescription}
        </p>
      </div>

      <fieldset className="min-w-0 space-y-3">
        <legend id={channelLegendId} className="max-w-full break-words text-sm font-semibold [overflow-wrap:anywhere]">
          {messages.feedbackChannelLegend}
        </legend>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <Label className="min-tap flex min-w-0 max-w-full cursor-pointer items-start gap-3 rounded-xl border border-border p-4 leading-normal [overflow-wrap:anywhere] has-[:checked]:border-primary has-[:checked]:bg-primary/10">
            <input
              className="mt-1 h-5 w-5 shrink-0 accent-primary"
              type="radio"
              name="feedback-channel"
              value="email"
              checked={channel === "email"}
              onChange={() => setChannel("email")}
            />
            <span className="min-w-0 space-y-1">
              <span className="flex min-w-0 flex-wrap items-center gap-2 break-words font-semibold [overflow-wrap:anywhere]"><Mail className="h-4 w-4" aria-hidden />{messages.feedbackEmailName}</span>
              <span className="block max-w-full break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">{messages.feedbackEmailPrivacy}</span>
            </span>
          </Label>
          <Label className="min-tap flex min-w-0 max-w-full cursor-pointer items-start gap-3 rounded-xl border border-border p-4 leading-normal [overflow-wrap:anywhere] has-[:checked]:border-primary has-[:checked]:bg-primary/10">
            <input
              className="mt-1 h-5 w-5 shrink-0 accent-primary"
              type="radio"
              name="feedback-channel"
              value="github"
              checked={channel === "github"}
              onChange={() => setChannel("github")}
            />
            <span className="min-w-0 space-y-1">
              <span className="flex min-w-0 flex-wrap items-center gap-2 break-words font-semibold [overflow-wrap:anywhere]"><MessagesSquare className="h-4 w-4" aria-hidden />{messages.feedbackGithubName}</span>
              <span className="block max-w-full break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">{messages.feedbackGithubPrivacy}</span>
            </span>
          </Label>
        </div>
      </fieldset>

      <div className="min-w-0 space-y-2">
        <Label htmlFor="feedback-description">
          {messages.feedbackDescriptionLabel}
        </Label>
        <Textarea
          id="feedback-description"
          className="min-h-36 min-w-0 max-w-full resize-y"
          maxLength={FEEDBACK_DESCRIPTION_LIMIT}
          value={description}
          aria-describedby="feedback-description-hint feedback-mnemonic-scope-hint"
          onChange={(event) => setDescription(event.target.value)}
        />
        <p id="feedback-description-hint" className="max-w-full break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {messages.feedbackDescriptionHint}
        </p>
        <p id="feedback-mnemonic-scope-hint" className="max-w-full break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {messages.feedbackMnemonicLanguageScope}
        </p>
      </div>

      <div className="grid min-w-0 max-w-full gap-3 rounded-xl border border-border p-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start">
        <Switch checked={diagnostics !== null} disabled aria-describedby={diagnosticsDescriptionId} aria-label={messages.feedbackDiagnosticsLabel} />
        <div className="min-w-0 space-y-1">
          <p className="max-w-full break-words text-sm font-medium [overflow-wrap:anywhere]">
            {messages.feedbackDiagnosticsLabel}
          </p>
          <p id={diagnosticsDescriptionId} className="max-w-full break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {messages.feedbackDiagnosticsUnavailable}
          </p>
        </div>
      </div>

      <Button type="button" disabled={channel === null || description.trim().length === 0} onClick={beginReview} className="h-auto min-h-11 max-w-full whitespace-normal break-words [overflow-wrap:anywhere]">
        {messages.feedbackReviewAction}
      </Button>
    </section>
  );
}
