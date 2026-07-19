import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, Clock, Lock, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/common/PageHeader";
import { Skeleton } from "@/components/ui/skeleton";
import { kyc } from "@/lib/api/free2z";
import { useSession } from "@/store/session";
import type { KycIdentityDocuments, KycProfile } from "@/lib/api/types";
import { Stepper } from "./Stepper";
import { BasicInfoStep } from "./steps/BasicInfoStep";
import { IdentityDocumentsStep } from "./steps/IdentityDocumentsStep";
import { TaxFormStep } from "./steps/TaxFormStep";
import { ReviewStep } from "./steps/ReviewStep";

/**
 * KYC / creator revenue-share APPLICATION flow — `dj.apps.kyc`
 * (/api/kyc/*, see src/lib/api/free2z.ts `kyc` for the confirmed contract).
 *
 * This is the application only: it walks a creator through identity
 * verification and a signed tax form, then submits for review
 * (application_status NEW → PENDING). There is no payout / cash-out surface
 * yet on the backend — APPROVED here only means "verified", not "can be
 * paid out."
 */
export default function KycFeature() {
  const user = useSession((s) => s.user);

  if (!user) {
    return (
      <div className="animate-slide-up">
        <PageHeader title="Apply for revenue share" />
        <EmptyState
          icon={Lock}
          title="Sign in to apply"
          description="Sign in with Zcash to start your creator revenue-share application."
          action={
            <Button asChild>
              <Link to="/login">Sign in with Zcash</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return <KycApplication key={user.username} />;
}

function KycApplication() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [profile, setProfile] = useState<KycProfile | null>(null);
  const [docs, setDocs] = useState<KycIdentityDocuments>({});
  const [taxFormUrl, setTaxFormUrl] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [step, setStep] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [p, d, t, s] = await Promise.all([
          kyc.getProfile(),
          kyc.getIdentityDocuments(),
          kyc.getTaxFormFile(),
          kyc.getTaxFormSignature(),
        ]);
        if (cancelled) return;
        setProfile(p);
        setDocs(d);
        setTaxFormUrl(t.file);
        setSignature(s.tax_form_signature);
      } catch {
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="animate-slide-up space-y-4">
        <PageHeader title="Apply for revenue share" />
        <Skeleton className="h-52 w-full rounded-xl" />
      </div>
    );
  }

  if (loadError || !profile) {
    return (
      <div className="animate-slide-up">
        <PageHeader title="Apply for revenue share" />
        <EmptyState
          title="Couldn't load your application"
          description="Something went wrong reaching the KYC service. Please try again shortly."
        />
      </div>
    );
  }

  if (profile.application_status === "REJECTED") {
    return (
      <div className="animate-slide-up">
        <PageHeader title="Revenue share" />
        <EmptyState
          icon={XCircle}
          title="Not eligible at this time"
          description="Your application wasn't approved for the revenue-share program."
        />
      </div>
    );
  }

  if (profile.application_status === "PENDING") {
    return (
      <div className="mx-auto max-w-2xl animate-slide-up">
        <PageHeader title="Revenue share" />
        <Card className="flex items-center gap-3 rounded-xl border-border/60 bg-card/60 p-5">
          <Clock className="h-5 w-5 shrink-0 text-primary" aria-hidden />
          <div>
            <div className="font-medium">Your application is under review</div>
            <p className="text-sm text-muted-foreground">
              We'll let you know as soon as a reviewer makes a decision.
            </p>
          </div>
        </Card>
      </div>
    );
  }

  if (profile.application_status === "APPROVED") {
    return (
      <div className="mx-auto max-w-2xl animate-slide-up">
        <PageHeader title="Revenue share" />
        <Card className="space-y-3 rounded-xl border-border/60 bg-card/60 p-5">
          <div className="flex items-center gap-3">
            <CheckCircle2
              className="h-5 w-5 shrink-0 text-emerald-400"
              aria-hidden
            />
            <div className="font-medium">
              You're approved for the revenue-share program
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            Payout / cash-out isn't live yet — this only confirms your
            creator verification is on file.
          </p>
          <Button
            variant="outline"
            onClick={async () => {
              await kyc.submit(); // APPROVED → NEW, re-opening the wizard.
              setProfile({ ...profile, application_status: "NEW" });
              setStep(0);
            }}
          >
            Revise application
          </Button>
        </Card>
      </div>
    );
  }

  // NEW — walk the wizard.
  return (
    <div className="mx-auto max-w-2xl animate-slide-up">
      <PageHeader
        title="Apply for revenue share"
        description="Verify your identity and complete a tax form to become an eligible revenue-share creator. This is the application step only — payouts aren't live yet."
      />
      <Stepper step={step} />
      {step === 0 ? (
        <BasicInfoStep
          profile={profile}
          onNext={(p) => {
            setProfile(p);
            setStep(1);
          }}
        />
      ) : null}
      {step === 1 ? (
        <IdentityDocumentsStep
          docs={docs}
          onNext={(d) => {
            setDocs(d);
            setStep(2);
          }}
          onBack={() => setStep(0)}
        />
      ) : null}
      {step === 2 ? (
        <TaxFormStep
          profile={profile}
          fileUrl={taxFormUrl}
          signature={signature}
          onNext={(url, sig) => {
            setTaxFormUrl(url);
            setSignature(sig);
            setStep(3);
          }}
          onBack={() => setStep(1)}
        />
      ) : null}
      {step === 3 ? (
        <ReviewStep
          profile={profile}
          docs={docs}
          taxFormUrl={taxFormUrl}
          signature={signature}
          onBack={() => setStep(2)}
          onSubmitted={() =>
            setProfile({ ...profile, application_status: "PENDING" })
          }
        />
      ) : null}
    </div>
  );
}
