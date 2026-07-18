// ZUULI — Login with Zcash.
//
// A standalone, full-viewport auth page (mounted at /login, outside the app
// shell). Split-screen: a cinematic brand panel on the left and the action
// panel on the right. The primary path is keys-only Zcash sign-in; classic
// free2z sign-in and guest browsing are offered as secondary "more ways".

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, HelpCircle, ShieldCheck } from "lucide-react";
import { Wordmark } from "@/components/brand/Logo";
import { Badge } from "@/components/ui/badge";
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
import { BrandPanel } from "./BrandPanel";
import { ClassicLoginForm } from "./ClassicLoginForm";
import { ZcashLoginFlow } from "./ZcashLoginFlow";
import { ZShieldInfo } from "./ZShieldInfo";

export default function AuthFeature() {
  const bootstrap = useWallet((s) => s.bootstrap);
  const [showClassic, setShowClassic] = useState(false);

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
            <CardHeader className="space-y-3">
              <div className="flex items-center justify-between">
                <Badge variant="default" className="gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                  Passwordless
                </Badge>
                <ZShieldInfo>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                    aria-label="How Login with Zcash works"
                  >
                    <HelpCircle className="h-3.5 w-3.5" aria-hidden />
                    How it works
                  </button>
                </ZShieldInfo>
              </div>
              <div className="space-y-1">
                <CardTitle className="text-2xl">Welcome to ZUULI</CardTitle>
                <CardDescription>
                  Your Zcash key is your identity. Sign in without a password.
                </CardDescription>
              </div>
            </CardHeader>

            <CardContent className="space-y-6">
              <ZcashLoginFlow />

              <div className="flex items-center gap-3">
                <Separator className="flex-1" />
                <span className="text-xs uppercase tracking-wider text-muted-foreground">
                  more ways
                </span>
                <Separator className="flex-1" />
              </div>

              {showClassic ? (
                <ClassicLoginForm />
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => setShowClassic(true)}
                >
                  I already have a free2z account
                </Button>
              )}

              <div className="text-center">
                <Button
                  asChild
                  variant="link"
                  size="sm"
                  className="text-muted-foreground"
                >
                  <Link to="/" aria-label="Explore ZUULI as a guest">
                    Explore first — continue as guest
                    <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
                  </Link>
                </Button>
              </div>
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
