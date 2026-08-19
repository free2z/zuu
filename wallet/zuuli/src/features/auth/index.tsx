// ZUULI — Login.
//
// A viewport-bound auth page mounted inside the persistent app shell. ZUULI is
// Zcash-native, so Login with Zcash leads as the default,
// prominent choice — passwordless, no email, no KYC. Email/username + password
// (with 2FA when enabled) and, soon, X / Google follow below as alternatives.

import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
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
import { loginDestinationFromState } from "@/lib/auth/login-destination";

type Method = "chooser" | "zcash";

export default function AuthFeature() {
  const location = useLocation();
  const loginDestination = loginDestinationFromState(location.state);
  const bootstrap = useWallet((s) => s.bootstrap);
  const [method, setMethod] = useState<Method>("chooser");

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  return (
    <div
      className="grid h-full min-h-0 w-full grid-cols-1 overflow-y-auto bg-background lg:grid-cols-2"
      data-route-scroll
    >
      <BrandPanel />

      <main className="app-auth-content relative flex min-h-full flex-col items-center justify-start p-6 sm:p-10">
        {/* Auto block margins center the stack only when it fits. Unlike
            justify-center, they collapse to zero when the stack is taller
            than the bounded scroller, so its top can always be reached. */}
        <div className="app-auth-stack my-auto flex w-full max-w-md flex-col">
          {/* Compact wordmark for small screens where the brand panel is hidden */}
          <div className="mb-8 lg:hidden">
            <Wordmark />
          </div>

          <div className="w-full animate-slide-up">
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
                      className="min-tap inline-flex items-center gap-1.5 rounded-md text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label="Back to all sign-in options"
                    >
                      <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
                      All sign-in options
                    </button>
                    <ZcashLoginFlow loginDestination={loginDestination} />
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
                    <ClassicLoginForm loginDestination={loginDestination} />

                    {/* X / Google / GitHub — renders only for providers the
                        backend reports as configured (none, today) */}
                    <SocialButtons loginDestination={loginDestination} />

                    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                      <ZShieldInfo>
                        <button
                          type="button"
                          className="min-tap inline-flex items-center gap-1.5 rounded-md text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
        </div>
      </main>
    </div>
  );
}
