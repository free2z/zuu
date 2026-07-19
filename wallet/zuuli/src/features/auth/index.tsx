// ZUULI — Login.
//
// A standalone, full-viewport auth page (mounted at /login, outside the app
// shell). ZUULI is Zcash-native, so Login with Zcash leads as the default,
// prominent choice — passwordless, no email, no KYC. Email/username + password
// (with 2FA when enabled) and, soon, X / Google follow below as alternatives.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ArrowUpRight, HelpCircle, ShieldCheck } from "lucide-react";
import { Wordmark } from "@/components/brand/Logo";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useWallet } from "@/store/wallet";
import { SocialButtons } from "@/components/common/SocialButtons";
import { BrandPanel } from "./BrandPanel";
import { ClassicLoginForm } from "./ClassicLoginForm";
import { ZcashLoginFlow } from "./ZcashLoginFlow";
import { ZShieldInfo } from "./ZShieldInfo";

type Method = "chooser" | "zcash";

export default function AuthFeature() {
  const bootstrap = useWallet((s) => s.bootstrap);
  const [method, setMethod] = useState<Method>("chooser");

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  return (
    <div className="grid min-h-screen w-full grid-cols-1 bg-background lg:grid-cols-2">
      <BrandPanel />

      <main className="relative flex min-h-screen flex-col items-center justify-center overflow-y-auto p-6 sm:p-10">
        {/* Compact wordmark for small screens where the brand panel is hidden */}
        <div className="mb-8 lg:hidden">
          <Wordmark />
        </div>

        <div className="w-full max-w-md animate-slide-up">
          <Card className="border-border/80 bg-card/70 shadow-glow backdrop-blur">
            <CardHeader className="space-y-1">
              <CardTitle className="text-2xl">Sign in to ZUULI</CardTitle>
              <CardDescription>
                {method === "zcash"
                  ? "Prove control of your Zcash key to sign in — no password."
                  : "Welcome back. Choose how you'd like to continue."}
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-6">
              {method === "zcash" ? (
                <div className="space-y-5">
                  <button
                    type="button"
                    onClick={() => setMethod("chooser")}
                    className="inline-flex items-center gap-1.5 rounded-md text-sm text-muted-foreground transition-colors hover:text-foreground"
                    aria-label="Back to all sign-in options"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
                    All sign-in options
                  </button>
                  <ZcashLoginFlow />
                </div>
              ) : (
                <>
                  {/* Primary method — Login with Zcash (default, passwordless) */}
                  <div className="space-y-2">
                    <Button
                      type="button"
                      size="lg"
                      className="w-full justify-center text-sm font-semibold"
                      onClick={() => setMethod("zcash")}
                    >
                      <ShieldCheck className="h-4 w-4" aria-hidden />
                      Continue with Zcash
                    </Button>
                    <p className="text-center text-xs text-muted-foreground">
                      Passwordless — prove control of your Zcash key. No email,
                      no KYC.
                    </p>
                  </div>

                  <div className="flex items-center gap-3">
                    <Separator className="flex-1" />
                    <span className="text-xs uppercase tracking-wider text-muted-foreground">
                      or use a password
                    </span>
                    <Separator className="flex-1" />
                  </div>

                  {/* Alternative — email/username + password (with 2FA) */}
                  <ClassicLoginForm />

                  {/* X / Google / GitHub — renders only for providers the
                      backend reports as configured (none, today) */}
                  <SocialButtons />

                  <div className="flex items-center justify-between">
                    <ZShieldInfo>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1.5 rounded-md text-xs text-muted-foreground transition-colors hover:text-foreground"
                        aria-label="How Login with Zcash works"
                      >
                        <HelpCircle className="h-3.5 w-3.5" aria-hidden />
                        How Zcash login works
                      </button>
                    </ZShieldInfo>

                    <Button
                      asChild
                      variant="link"
                      size="sm"
                      className="text-muted-foreground"
                    >
                      <Link to="/" aria-label="Explore ZUULI as a guest">
                        Continue as guest
                        <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
                      </Link>
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <p className="mt-6 text-center text-xs text-muted-foreground lg:hidden">
            © {new Date().getFullYear()} 2Z Inc
          </p>
        </div>
      </main>
    </div>
  );
}
