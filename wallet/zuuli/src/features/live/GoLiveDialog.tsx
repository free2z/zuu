import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Radio, Loader2, LogIn } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { live } from "@/lib/api/free2z";
import { ApiError } from "@/lib/api/http";
import { useSession } from "@/store/session";
import { formatTuzis } from "@/lib/format";
import type { StreamKind } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { KIND_META, KIND_ORDER } from "./lib";

export function GoLiveDialog() {
  const navigate = useNavigate();
  const user = useSession((s) => s.user);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<StreamKind>("broadcast");
  const [title, setTitle] = useState("");
  const [price, setPrice] = useState("100");
  const [starting, setStarting] = useState(false);

  const priceNum = Math.max(0, Math.round(Number(price) || 0));
  const canStart =
    title.trim().length > 0 &&
    !starting &&
    (kind !== "ppv" || priceNum > 0);

  async function handleStart() {
    if (!canStart) return;
    setStarting(true);
    try {
      const ticket = await live.start(kind);
      const username = user?.username || "you";
      toast.success("You're live", {
        description: title.trim(),
      });
      setOpen(false);
      // Hand the host ticket + stream metadata to the room so the creator
      // lands already connected as host.
      navigate(`/live/${username}`, {
        state: {
          justStarted: {
            ticket,
            kind,
            title: title.trim(),
            price_tuzis: priceNum,
          },
        },
      });
    } catch (e) {
      // Defense-in-depth: even though the control is auth-gated below, a session
      // can expire between load and submit. Intercept the auth failure with a
      // friendly redirect instead of surfacing the raw backend 401 text
      // ("Authentication credentials were not provided.").
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setOpen(false);
        toast.error("Sign in to go live", {
          description: "Your session ended — please sign in again.",
        });
        navigate("/login");
        return;
      }
      toast.error("Could not start stream", {
        description: e instanceof Error ? e.message : "Please try again.",
      });
    } finally {
      setStarting(false);
    }
  }

  // Going live requires an account. When signed out, don't offer a broadcast
  // action that can only fail — route the user to sign in instead.
  if (!user) {
    return (
      <Button
        size="lg"
        variant="outline"
        className="gap-2"
        onClick={() => navigate("/login")}
      >
        <LogIn className="h-4 w-4" aria-hidden />
        Authenticate to go live
      </Button>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="lg" className="gap-2">
          <Radio className="h-4 w-4" aria-hidden />
          Go Live
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Go live</DialogTitle>
          <DialogDescription>
            Start a stream. Choose who can watch and how they pay to get in.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Stream type</Label>
            <div
              role="radiogroup"
              aria-label="Stream type"
              className="grid grid-cols-2 gap-2"
            >
              {KIND_ORDER.map((k) => {
                const meta = KIND_META[k];
                const active = kind === k;
                return (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setKind(k)}
                    className={cn(
                      "flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "border-primary/60 bg-primary/10 shadow-glow"
                        : "border-border bg-background/40 hover:border-primary/30",
                    )}
                  >
                    <span className="text-sm font-medium">{meta.short}</span>
                    <span className="text-[11px] leading-tight text-muted-foreground">
                      {meta.blurb}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="go-live-title">Title</Label>
            <Input
              id="go-live-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What are you streaming?"
              autoFocus
              maxLength={120}
            />
          </div>

          {kind === "ppv" ? (
            <div className="space-y-2">
              <Label htmlFor="go-live-price">Join price (2Z)</Label>
              <Input
                id="go-live-price"
                type="number"
                inputMode="numeric"
                min={1}
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="tabular-nums"
              />
              <p className="text-xs text-muted-foreground">
                Viewers spend{" "}
                <span className="font-medium text-amber-400 tabular-nums">
                  {formatTuzis(priceNum)}
                </span>{" "}
                to join.
              </p>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={starting}
          >
            Cancel
          </Button>
          <Button onClick={handleStart} disabled={!canStart} className="gap-2">
            {starting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Starting…
              </>
            ) : (
              "Start stream"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
