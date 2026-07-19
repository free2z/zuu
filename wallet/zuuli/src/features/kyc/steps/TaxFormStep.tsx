import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { kyc } from "@/lib/api/free2z";
import type { KycProfile, KycTaxFormKind } from "@/lib/api/types";
import { UploadSlot } from "../UploadSlot";

/** Which IRS form applies, mirroring ts/react/free2z's KYCTaxForm.tsx. */
function taxFormFor(profile: KycProfile): {
  kind: KycTaxFormKind;
  description: string;
  url: string;
} {
  if (profile.is_us) {
    return {
      kind: "W-9",
      description: profile.is_individual
        ? "for US individuals"
        : "for US entities",
      url: "https://www.irs.gov/pub/irs-pdf/fw9.pdf",
    };
  }
  return profile.is_individual
    ? {
        kind: "W-8BEN",
        description: "for non-US individuals",
        url: "https://www.irs.gov/pub/irs-pdf/fw8ben.pdf",
      }
    : {
        kind: "W-8BEN-E",
        description: "for non-US entities",
        url: "https://www.irs.gov/pub/irs-pdf/fw8bene.pdf",
      };
}

/**
 * Step 3 — upload the filled-out tax form (POST /api/kyc/upload-tax-form,
 * multipart field `file`) then e-sign it (POST /api/kyc/tax-form-signature,
 * body `{ tax_form_signature }`).
 */
export function TaxFormStep({
  profile,
  fileUrl,
  signature,
  onNext,
  onBack,
}: {
  profile: KycProfile;
  fileUrl: string | null;
  signature: string | null;
  onNext: (fileUrl: string | null, signature: string | null) => void;
  onBack: () => void;
}) {
  const [file, setFile] = useState(fileUrl);
  const [sig, setSig] = useState(signature ?? "");
  const [checked, setChecked] = useState(Boolean(signature));
  const [uploading, setUploading] = useState(false);
  const [signing, setSigning] = useState(false);

  const form = taxFormFor(profile);

  async function handleSelect(f: File) {
    setUploading(true);
    try {
      const res = await kyc.uploadTaxForm(f);
      setFile(res.file_url);
    } catch {
      toast.error("Couldn't upload the form. Please try again.");
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete() {
    try {
      await kyc.deleteTaxForm();
      setFile(null);
    } catch {
      toast.error("Couldn't remove the form. Please try again.");
    }
  }

  async function handleContinue() {
    const trimmed = sig.trim();
    if (!file || !trimmed || !checked || signing) return;
    setSigning(true);
    try {
      await kyc.signTaxForm(trimmed);
      onNext(file, trimmed);
    } catch {
      toast.error("Couldn't save your signature. Please try again.");
    } finally {
      setSigning(false);
    }
  }

  const canContinue = Boolean(file) && sig.trim().length > 0 && checked && !signing;

  return (
    <Card className="space-y-5 rounded-xl border-border/60 bg-card/60 p-5">
      <CardHeader className="p-0 pb-1">
        <CardTitle className="text-lg">Tax form — {form.kind}</CardTitle>
        <CardDescription>
          Download, fill out, and upload the {form.kind} form ({form.description}
          ). No wet signature needed — you'll e-sign below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 p-0">
        <a
          href={form.url}
          target="_blank"
          rel="noreferrer"
          className="inline-block text-sm text-primary underline-offset-4 hover:underline"
        >
          Download the {form.kind} form (IRS.gov)
        </a>
        <UploadSlot
          label={`${form.kind} form (PDF)`}
          required
          accept="application/pdf"
          url={file}
          uploading={uploading}
          onSelect={handleSelect}
          onDelete={handleDelete}
        />
        <div className="space-y-2 border-t border-border/60 pt-4">
          <Label htmlFor="kyc-signature">
            Type your full legal name to e-sign
          </Label>
          <Input
            id="kyc-signature"
            value={sig}
            onChange={(e) => setSig(e.target.value)}
            placeholder="Full legal name"
            disabled={!file}
          />
          <label className="flex items-start gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              disabled={!file}
              className="mt-0.5 h-3.5 w-3.5 rounded border-border"
            />
            I understand that typing my name above acts as my legal signature
            on the uploaded tax form.
          </label>
        </div>
      </CardContent>
      <div className="flex justify-between pt-2">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button onClick={handleContinue} disabled={!canContinue}>
          {signing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          Continue
        </Button>
      </div>
    </Card>
  );
}
