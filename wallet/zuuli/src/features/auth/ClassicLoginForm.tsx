// Username/password sign-in — a first-class login method, peer to Login with
// Zcash. When the account has 2FA (TOTP) enabled, the password step hands off
// to a second, 6-digit code step before the session is considered established.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ArrowLeft, Loader2, LogIn, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { auth } from "@/lib/api/free2z";
import { setToken } from "@/lib/api/http";
import type { AuthenticatedSession } from "@/lib/api/types";
import { useSession } from "@/store/session";
import type { LoginDestination } from "@/lib/auth/login-destination";
import { useAttemptLease, type IsCurrentAttempt } from "@/hooks/useAttemptLease";

export function ClassicLoginForm({
  loginDestination = "/",
  onBusyChange,
}: {
  loginDestination?: LoginDestination;
  onBusyChange?: (busy: boolean) => void;
}) {
  const navigate = useNavigate();
  const setUser = useSession((s) => s.setUser);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When 2FA is required, we advance to the code step; the password stays in
  // component memory only long enough to complete the second factor.
  const [needsOtp, setNeedsOtp] = useState(false);
  const attempt = useAttemptLease();

  function land(session: AuthenticatedSession, isCurrent: IsCurrentAttempt) {
    if (!isCurrent()) return;
    setToken(session.token);
    setUser(session.user);
    toast.success("Welcome back", {
      description: `Logged in as ${session.user.username}.`,
    });
    navigate(loginDestination, { replace: true });
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!username || !password || submitting) return;
    setSubmitting(true);
    const isCurrent = attempt.begin();
    onBusyChange?.(true);
    setError(null);
    try {
      const result = await auth.login(username.trim(), password);
      if (!isCurrent()) return;
      if (result.status === "otp_required") {
        setNeedsOtp(true);
      } else {
        land(result.session, isCurrent);
      }
    } catch (err) {
      if (!isCurrent()) return;
      setError(
        err instanceof Error ? err.message : "Sign-in failed. Check your details.",
      );
    } finally {
      if (isCurrent()) {
        setSubmitting(false);
        onBusyChange?.(false);
      }
    }
  }

  if (needsOtp) {
    return (
      <OtpStep
        username={username.trim()}
        password={password}
        onVerified={land}
        beginAttempt={attempt.begin}
        onBusyChange={onBusyChange}
        onBack={() => {
          attempt.invalidate();
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
        {submitting ? "Logging in…" : "Log in"}
      </Button>
    </form>
  );
}

// ─── Second factor: 6-digit TOTP code ────────────────────────────────────────

function OtpStep({
  username,
  password,
  onVerified,
  beginAttempt,
  onBack,
  onBusyChange,
}: {
  username: string;
  password: string;
  onVerified: (session: AuthenticatedSession, isCurrent: IsCurrentAttempt) => void;
  beginAttempt: () => IsCurrentAttempt;
  onBack: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (code.length !== 6 || submitting) return;
    setSubmitting(true);
    const isCurrent = beginAttempt();
    onBusyChange?.(true);
    setError(null);
    try {
      const session = await auth.completeOtp(username, password, code);
      if (!isCurrent()) return;
      onVerified(session, isCurrent);
    } catch (err) {
      if (!isCurrent()) return;
      setError(err instanceof Error ? err.message : "Verification failed.");
      setCode("");
    } finally {
      if (isCurrent()) {
        setSubmitting(false);
        onBusyChange?.(false);
      }
    }
  }

  return (
    <form onSubmit={onSubmit} className="animate-slide-up space-y-4">
      <div className="flex items-start gap-3 rounded-lg border border-border bg-background/40 p-4">
        <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-secondary text-muted-foreground">
          <ShieldCheck className="h-5 w-5" aria-hidden />
        </span>
        <div className="space-y-0.5">
          <p className="text-sm font-medium">Two-factor authentication</p>
          <p className="text-sm text-muted-foreground">
            Enter the 6-digit code from your authenticator app to finish logging
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
        {submitting ? "Verifying…" : "Verify and log in"}
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
