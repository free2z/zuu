import { useRef, useState } from "react";
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
import {
  formatTuzis,
  MAX_PPV_PRICE_TUZIS,
  tuziInputExample,
  tuziInputMaxLength,
  validateTuzis,
} from "@/lib/format";
import type { StreamKind } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { privateInvitePath } from "@/lib/private-live";
import { KIND_META, KIND_ORDER } from "./lib";
import { MediaPreflight } from "./MediaPreflight";
import { useMediaPreflight } from "./useMediaPreflight";
import { startAfterMediaConfirmation } from "./media-preflight";

export function GoLiveDialog() {
  const navigate = useNavigate();
  const user = useSession((s) => s.user);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<StreamKind>("broadcast");
  const [title, setTitle] = useState("");
  const [price, setPrice] = useState("100");
  const [starting, setStarting] = useState(false);
  const startInFlight = useRef(false);
  const preflight = useMediaPreflight({ active: open });

  const priceResult = validateTuzis(price, {
    minimum: 1,
    maximum: MAX_PPV_PRICE_TUZIS,
  });
  const priceNum = priceResult.value;
  const validPrice = priceResult.error === null;
  const canStart =
    title.trim().length > 0 &&
    !starting &&
    preflight.status === "ready" &&
    (kind !== "ppv" || validPrice);

  async function handleStart() {
    if (
      !canStart ||
      startInFlight.current ||
      preflight.status !== "ready" ||
      (kind === "ppv" && priceNum === null)
    ) return;
    startInFlight.current = true;
    setStarting(true);
    try {
      const { ticket, inviteSecret } = await startAfterMediaConfirmation({
        confirmed: preflight.status === "ready",
        release: preflight.release,
        provision: () => live.start(kind),
      });
      const username = user?.username || "you";
      toast.success("You're live", {
        description: title.trim(),
      });
      setOpen(false);
      // Hand the host ticket + stream metadata to the room so the creator
      // lands already connected as host.
      navigate(
        kind === "private" && inviteSecret
          ? privateInvitePath(username, inviteSecret)
          : `/live/${encodeURIComponent(username)}`,
        {
          state: {
            justStarted: {
              ticket,
              inviteSecret,
              kind,
              title: title.trim(),
              price_tuzis: kind === "ppv" ? priceNum : 0,
            },
          },
        },
      );
    } catch (e) {
      // Defense-in-depth: even though the control is auth-gated below, a session
      // can expire between load and submit. Intercept the auth failure with a
      // friendly redirect instead of surfacing the raw backend 401 text
      // ("Authentication credentials were not provided.").
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setOpen(false);
        toast.error("Log in to go live", {
          description: "Your session ended — please log in again.",
        });
        navigate("/login");
        return;
      }
      toast.error("Could not start stream", {
        description: e instanceof Error ? e.message : "Please try again.",
      });
    } finally {
      startInFlight.current = false;
      setStarting(false);
    }
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) preflight.release();
    setOpen(nextOpen);
  }

  // Going live requires an account. When signed out, don't offer a broadcast
  // action that can only fail — route the user to log in instead.
  if (!user) {
    return (
      <Button
        size="lg"
        variant="outline"
        className="gap-2"
        onClick={() => navigate("/login")}
      >
        <LogIn className="rtl:-scale-x-100 h-4 w-4" aria-hidden />
        Log in to go live
      </Button>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="lg" className="gap-2">
          <Radio className="h-4 w-4" aria-hidden />
          Go Live
        </Button>
      </DialogTrigger>
      <DialogContent
        className="max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-md overflow-y-auto rounded-xl p-4 sm:p-6"
        closeClassName="min-tap grid place-items-center rounded-md"
      >
        <DialogHeader>
          <DialogTitle>Go live</DialogTitle>
          <DialogDescription>
            Choose who can watch, then check your camera and microphone before
            anything is started.
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
                      "min-tap flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-start transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "border-primary/60 bg-primary/10"
                        : "border-border bg-background/40 hover:border-primary/30",
                    )}
                  >
                    <span className="text-sm font-medium">{meta.short}</span>
                    <span className="text-xs leading-tight text-muted-foreground">
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
                type="text"
                inputMode="numeric"
                maxLength={tuziInputMaxLength(MAX_PPV_PRICE_TUZIS)}
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="bidi-number tabular-nums"
                aria-describedby="go-live-price-error go-live-price-summary"
                aria-invalid={!validPrice}
              />
              <p id="go-live-price-summary" className="text-xs text-muted-foreground">
                Viewers spend{" "}
                <span className="font-medium text-warning bidi-number tabular-nums">
                  {priceNum !== null && priceNum > 0 ? formatTuzis(priceNum) : "—"}
                </span>{" "}
                to join.
              </p>
              <p id="go-live-price-error" className="min-h-[1rem] text-xs text-destructive">
                {priceResult.error === "tooLarge"
                  ? `Max ${MAX_PPV_PRICE_TUZIS.toLocaleString()} 2Z for PPV.`
                  : !validPrice
                    ? `Enter a positive whole 2Z amount, e.g. ${tuziInputExample()}.`
                    : null}
              </p>
            </div>
          ) : null}

          <MediaPreflight model={preflight} disabled={starting} />
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => handleOpenChange(false)}
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
              "Confirm and start"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
