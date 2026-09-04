import { useState } from "react";
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
import type { KycIdentityDocType, KycIdentityDocuments } from "@/lib/api/types";
import { UploadSlot } from "../UploadSlot";

const SLOTS: {
  type: KycIdentityDocType;
  label: string;
  description: string;
  required: boolean;
}[] = [
  {
    type: "id_front",
    label: "Government-issued ID (front)",
    description: "Passport, driver's license, or national ID — front side.",
    required: true,
  },
  {
    type: "id_back",
    label: "Government-issued ID (back)",
    description: "The back side, if your ID has one.",
    required: false,
  },
  {
    type: "additional_document",
    label: "Proof of address",
    description: "A recent utility bill or bank statement.",
    required: false,
  },
  {
    type: "live_photo",
    label: "Live photo",
    description: "A current photo of yourself, for identity verification.",
    required: true,
  },
];

/**
 * Step 2 — /api/kyc/identity-documents. Each slot's file field name IS the
 * doc type (`id_front`, `id_back`, `additional_document`, `live_photo`); the
 * GET response returns `{ <doctype>_url }` per uploaded slot.
 */
export function IdentityDocumentsStep({
  docs,
  onNext,
  onBack,
}: {
  docs: KycIdentityDocuments;
  onNext: (docs: KycIdentityDocuments) => void;
  onBack: () => void;
}) {
  const [current, setCurrent] = useState<KycIdentityDocuments>(docs);
  const [uploading, setUploading] = useState<
    Partial<Record<KycIdentityDocType, boolean>>
  >({});

  async function handleSelect(type: KycIdentityDocType, file: File) {
    setUploading((u) => ({ ...u, [type]: true }));
    try {
      const updated = await kyc.uploadIdentityDocument(type, file);
      setCurrent(updated);
    } catch {
      toast.error("Couldn't upload that file. Please try again.");
    } finally {
      setUploading((u) => ({ ...u, [type]: false }));
    }
  }

  async function handleDelete(type: KycIdentityDocType) {
    try {
      await kyc.deleteIdentityDocument(type);
      setCurrent((c) => {
        const next = { ...c };
        delete next[`${type}_url`];
        return next;
      });
    } catch {
      toast.error("Couldn't remove that file. Please try again.");
    }
  }

  const canContinue = Boolean(current.id_front_url && current.live_photo_url);

  return (
    <Card className="space-y-5 rounded-xl border-border/60 bg-card/60 p-5">
      <CardHeader className="p-0 pb-1">
        <CardTitle className="text-lg">Identity documents</CardTitle>
        <CardDescription>
          Upload the files below so we can verify who you are.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 p-0">
        {SLOTS.map((slot) => (
          <UploadSlot
            key={slot.type}
            label={slot.label}
            description={slot.description}
            required={slot.required}
            url={current[`${slot.type}_url`]}
            uploading={Boolean(uploading[slot.type])}
            onSelect={(file) => handleSelect(slot.type, file)}
            onDelete={() => handleDelete(slot.type)}
          />
        ))}
      </CardContent>
      <div className="flex justify-between pt-2">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button onClick={() => onNext(current)} disabled={!canContinue}>
          Continue
        </Button>
      </div>
    </Card>
  );
}
