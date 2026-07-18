// Username/password sign-in — a first-class login method, peer to Login with
// Zcash. When the account has 2FA (TOTP) enabled, the password step hands off
// to a second, 6-digit code step before the session is considered established.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ArrowLeft, Link2, Loader2, LogIn, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { auth } from "@/lib/api/free2z";
import type { AuthUser } from "@/lib/api/types";
import { useSession } from "@/store/session";

export function ClassicLoginForm() {
  const navigate = useNavigate();
  const setUser = useSession((s) => s.setUser);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When 2FA is required, we advance to the code step; the password stays in
  // component memory only long enough to complete the second factor.
  const [needsOtp, setNeedsOtp] = useState(false);

  function land(user: AuthUser) {
    setUser(user);
    toast.success("Welcome back", {
      description: `Signed in as ${user.username}.`,
    });
    navigate("/");
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!username || !password || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await auth.login(username.trim(), password);
      if (result.status === "otp_required") {
        setNeedsOtp(true);
      } else {
        land(result.user);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Sign-in failed. Check your details.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (needsOtp) {
    return (
      <OtpStep
        username={username.trim()}
        password={password}
        onVerified={land}
        onBack={() => {
          setNeedsOtp(false);
          setError(null);
        }}
      />
    );
  }

  return (
    <form onSubmit={onSubmit} className="animate-slide-up space-y-4">
      <div className="space-y-2">
        <Label htmlFor="f2z-username">Email or username</Label>
        <Input
          id="f2z-username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="you@example.com"
          disabled={submitting}
          aria-invalid={!!error}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="f2z-password">Password</Label>
        <Input
          id="f2z-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          disabled={submitting}
          aria-invalid={!!error}
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <Button
        type="submit"
        className="w-full"
        disabled={!username || !password || submitting}
      >
        {submitting ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : (
          <LogIn className="h-4 w-4" aria-hidden />
        )}
        {submitting ? "Signing in…" : "Sign in"}
      </Button>

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Link2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
        You can link this account to your Zcash identity later for keys-only
        sign-in.
      </p>
    </form>
  );
}

// ─── Second factor: 6-digit TOTP code ────────────────────────────────────────

function OtpStep({
  username,
  password,
  onVerified,
  onBack,
}: {
  username: string;
  password: string;
  onVerified: (user: AuthUser) => void;
  onBack: () => void;
}) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (code.length !== 6 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const user = await auth.completeOtp(username, password, code);
      onVerified(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed.");
      setCode("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="animate-slide-up space-y-4">
      <div className="flex items-start gap-3 rounded-lg border border-border bg-background/40 p-4">
        <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
          <ShieldCheck className="h-5 w-5" aria-hidden />
        </span>
        <div className="space-y-0.5">
          <p className="text-sm font-medium">Two-factor authentication</p>
          <p className="text-sm text-muted-foreground">
            Enter the 6-digit code from your authenticator app to finish signing
            in as{" "}
            <span className="font-medium text-foreground">{username}</span>.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="f2z-otp">Authentication code</Label>
        <Input
          id="f2z-otp"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          placeholder="000000"
          className="text-center text-lg tracking-[0.5em] tabular-nums"
          disabled={submitting}
          aria-invalid={!!error}
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <Button
        type="submit"
        className="w-full"
        disabled={code.length !== 6 || submitting}
      >
        {submitting ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : (
          <ShieldCheck className="h-4 w-4" aria-hidden />
        )}
        {submitting ? "Verifying…" : "Verify and sign in"}
      </Button>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-full text-muted-foreground"
        onClick={onBack}
        disabled={submitting}
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Use a different account
      </Button>
    </form>
  );
}
