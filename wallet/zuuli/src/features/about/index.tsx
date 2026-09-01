import { useState } from "react";
import { Check, Clipboard, Info } from "lucide-react";
import { PageHeader } from "@/components/common/PageHeader";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  BUILD_INFO,
  buildChannelLabel,
  buildPlatformLabel,
  formatBuildInfoMinimal,
  shortSourceCommit,
  type BuildInfo,
} from "@/lib/build-info";
import {
  resolveAboutMessages,
  type AboutMessages,
} from "./copy";
import { FeedbackComposer } from "./FeedbackComposer";

type AboutBuildCardProps = {
  buildInfo?: BuildInfo;
  messages?: AboutMessages;
};

function BuildRow({
  label,
  value,
  opaque = false,
}: {
  label: string;
  value: string;
  opaque?: boolean;
}) {
  return (
    <div className="grid min-w-0 gap-1 sm:grid-cols-[minmax(8rem,auto)_minmax(0,1fr)] sm:gap-4">
      <dt className="min-w-0 break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">
        {label}
      </dt>
      <dd
        className={opaque ? "mono-id min-w-0 break-all text-sm" : "min-w-0 break-words text-sm"}
        dir={opaque ? "ltr" : undefined}
      >
        {value}
      </dd>
    </div>
  );
}

export function AboutBuildCard({
  buildInfo = BUILD_INFO,
  messages = resolveAboutMessages(),
}: AboutBuildCardProps) {
  const [copyState, setCopyState] = useState<"idle" | "success" | "failure">(
    "idle",
  );
  const commit = shortSourceCommit(buildInfo.sourceCommit);

  async function copyBuildInfo() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(
        formatBuildInfoMinimal(buildInfo, messages),
      );
      setCopyState("success");
    } catch {
      setCopyState("failure");
    }
  }

  return (
    <Card className="min-w-0 overflow-hidden" data-about-build-card>
      <CardHeader className="min-w-0 p-4 sm:p-6">
        <CardTitle className="min-w-0 break-words text-lg [overflow-wrap:anywhere]">
          <h2 className="min-w-0 break-words [overflow-wrap:anywhere]">
            <Info className="me-2 inline h-5 w-5" aria-hidden />
            {messages.buildHeading}
          </h2>
        </CardTitle>
        <CardDescription className="min-w-0 break-words [overflow-wrap:anywhere]">
          {messages.buildDescription}
        </CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 space-y-5 p-4 pt-0 sm:p-6 sm:pt-0">
        <dl className="min-w-0 space-y-3" aria-label={messages.buildHeading}>
          <BuildRow label={messages.productLabel} value={buildInfo.productName} />
          <BuildRow label={messages.versionLabel} value={buildInfo.version} />
          <BuildRow label={messages.buildLabel} value={String(buildInfo.build)} />
          <BuildRow
            label={messages.channelLabel}
            value={buildChannelLabel(buildInfo.channel, messages)}
          />
          <BuildRow
            label={messages.platformLabel}
            value={buildPlatformLabel(buildInfo.platform, messages)}
          />
          <BuildRow
            label={messages.commitLabel}
            value={commit ?? messages.unavailable}
            opaque={Boolean(commit)}
          />
        </dl>

        <div className="flex min-w-0 flex-col items-start gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-auto min-h-11 max-w-full whitespace-normal break-words text-center [overflow-wrap:anywhere]"
            onClick={() => void copyBuildInfo()}
          >
            {copyState === "success" ? <Check aria-hidden /> : <Clipboard aria-hidden />}
            {messages.copyAction}
          </Button>
          <p
            className="min-h-5 max-w-full break-words text-sm text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            {copyState === "success"
              ? messages.copySuccess
              : copyState === "failure"
                ? messages.copyFailure
                : ""}
          </p>
        </div>

        <details className="group min-w-0 border-t border-border pt-3">
          <summary className="min-tap flex min-w-0 cursor-pointer list-none items-center break-words text-sm font-medium text-link [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {messages.provenanceSummary}
          </summary>
          <dl className="mt-3 min-w-0 space-y-3">
            <BuildRow
              label={messages.applicationIdLabel}
              value={buildInfo.applicationId}
              opaque
            />
            <BuildRow
              label={messages.fullCommitLabel}
              value={buildInfo.sourceCommit ?? messages.unavailable}
              opaque={Boolean(buildInfo.sourceCommit)}
            />
            <BuildRow
              label={messages.metadataSourceLabel}
              value={messages.metadataSourceValue}
            />
          </dl>
        </details>
      </CardContent>
    </Card>
  );
}

export default function AboutFeature() {
  const messages = resolveAboutMessages();
  return (
    <div className="mx-auto min-w-0 max-w-3xl pb-6" data-about-page>
      <PageHeader
        title={messages.pageTitle}
        description={messages.pageDescription}
      />
      <AboutBuildCard messages={messages} />
      <div className="mt-6 px-4 sm:px-0">
        <FeedbackComposer
          minimalBuildBlock={formatBuildInfoMinimal(BUILD_INFO, messages)}
          messages={messages}
        />
      </div>
    </div>
  );
}
