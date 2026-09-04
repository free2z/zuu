import { useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { kyc } from "@/lib/api/free2z";
import type { KycIdentityDocuments, KycProfile } from "@/lib/api/types";

/** Step 4 — POST /api/kyc/change-status (no body): NEW → PENDING. */
export function ReviewStep({
  profile,
  docs,
  taxFormUrl,
  signature,
  onBack,
  onSubmitted,
}: {
  profile: KycProfile;
  docs: KycIdentityDocuments;
  taxFormUrl: string | null;
  signature: string | null;
  onBack: () => void;
  onSubmitted: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    setSubmitting(true);
    try {
      await kyc.submit();
      toast.success("Application submitted for review");
      onSubmitted();
    } catch {
      toast.error("Couldn't submit your application. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const rows: { label: string; value: string; ok: boolean }[] = [
    {
      label: "Tax residency",
      value: profile.is_us ? "United States" : "Outside the United States",
      ok: profile.is_us !== null,
    },
    {
      label: "Filer type",
      value: profile.is_individual ? "Individual" : "Entity",
      ok: profile.is_individual !== null,
    },
    {
      label: "Government ID",
      value: docs.id_front_url ? "Uploaded" : "Missing",
      ok: Boolean(docs.id_front_url),
    },
    {
      label: "Live photo",
      value: docs.live_photo_url ? "Uploaded" : "Missing",
      ok: Boolean(docs.live_photo_url),
    },
    {
      label: "Tax form",
      value: taxFormUrl ? "Uploaded" : "Missing",
      ok: Boolean(taxFormUrl),
    },
    {
      label: "E-signature",
      value: signature || "Missing",
      ok: Boolean(signature),
    },
  ];
  const canSubmit = rows.every((r) => r.ok) && !submitting;

  return (
    <Card className="space-y-5 rounded-xl border-border/60 bg-card/60 p-5">
      <CardHeader className="p-0 pb-1">
        <CardTitle className="text-lg">Review & submit</CardTitle>
        <CardDescription>
          Confirm everything below, then submit for review. We'll let you know
          once a reviewer has made a decision — this only submits your
          application, it does not enable payouts.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-0 p-0">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center justify-between border-b border-border/40 py-2 text-sm last:border-0"
          >
            <span className="text-muted-foreground">{row.label}</span>
            <span
              className={row.ok ? "font-medium" : "font-medium text-destructive"}
            >
              {row.value}
            </span>
          </div>
        ))}
      </CardContent>
      <div className="flex justify-between pt-2">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button onClick={handleSubmit} disabled={!canSubmit}>
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <CheckCircle2 className="h-4 w-4" aria-hidden />
          )}
          Submit application
        </Button>
      </div>
    </Card>
  );
}
