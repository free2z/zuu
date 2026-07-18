// Fallback path — sign in with an existing free2z username + password. Once
// signed in, the account can be associated with your Zcash identity so future
// logins are keys-only.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Link2, Loader2, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { auth } from "@/lib/api/free2z";
import { useSession } from "@/store/session";

export function ClassicLoginForm() {
  const navigate = useNavigate();
  const setUser = useSession((s) => s.setUser);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!username || !password || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const user = await auth.login(username.trim(), password);
      setUser(user);
      toast.success("Welcome back", { description: `Signed in as ${user.username}.` });
      navigate("/");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Sign-in failed. Check your details.";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="animate-slide-up space-y-4">
      <div className="space-y-2">
        <Label htmlFor="f2z-username">Username</Label>
        <Input
          id="f2z-username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="your-handle"
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
        variant="secondary"
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
