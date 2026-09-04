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
import { cn } from "@/lib/utils";
import { kyc } from "@/lib/api/free2z";
import type { KycProfile } from "@/lib/api/types";

/** Step 1 — POST /api/kyc/user-profile: tax residency + filer type. */
export function BasicInfoStep({
  profile,
  onNext,
}: {
  profile: KycProfile;
  onNext: (profile: KycProfile) => void;
}) {
  const [isUs, setIsUs] = useState<boolean | null>(profile.is_us);
  const [isIndividual, setIsIndividual] = useState<boolean | null>(
    profile.is_individual,
  );
  const [saving, setSaving] = useState(false);

  const canContinue = isUs !== null && isIndividual !== null && !saving;

  async function handleContinue() {
    if (isUs === null || isIndividual === null) return;
    setSaving(true);
    try {
      const updated = await kyc.saveProfile({
        is_us: isUs,
        is_individual: isIndividual,
      });
      onNext(updated);
    } catch {
      toast.error("Couldn't save your info. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="rounded-xl border-border/60 bg-card/60 p-5">
      <CardHeader className="p-0 pb-4">
        <CardTitle className="text-lg">Basic information</CardTitle>
        <CardDescription>
          This determines which tax form you'll complete next.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 p-0">
        <ToggleGroup
          label="Are you a US taxpayer?"
          value={isUs}
          onChange={setIsUs}
          options={[
            { value: true, label: "US" },
            { value: false, label: "Non-US" },
          ]}
        />
        <ToggleGroup
          label="Are you an individual or an entity?"
          value={isIndividual}
          onChange={setIsIndividual}
          options={[
            { value: true, label: "Individual" },
            { value: false, label: "Entity" },
          ]}
        />
      </CardContent>
      <div className="mt-6 flex justify-end">
        <Button onClick={handleContinue} disabled={!canContinue}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          Continue
        </Button>
      </div>
    </Card>
  );
}

function ToggleGroup({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: boolean | null;
  onChange: (v: boolean) => void;
  options: { value: boolean; label: string }[];
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{label}</p>
      <div className="grid grid-cols-2 gap-2">
        {options.map((opt) => (
          <button
            key={String(opt.value)}
            type="button"
            onClick={() => onChange(opt.value)}
            className={cn(
              "min-tap rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors",
              value === opt.value
                ? "border-primary bg-primary/15 text-primary"
                : "border-border bg-transparent text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
