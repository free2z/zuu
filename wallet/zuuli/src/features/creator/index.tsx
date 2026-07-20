import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Check,
  Clock,
  Facebook,
  FileText,
  Github,
  Globe,
  Heart,
  Instagram,
  Link2,
  Linkedin,
  Loader2,
  Radio,
  Send,
  Twitter,
  UserX,
  Youtube,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import type { LucideIcon } from "lucide-react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
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
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common/EmptyState";
import { Markdown } from "@/components/common/Markdown";
import { discover, live, tuzi } from "@/lib/api/free2z";
import { formatTuzis, initials, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { parseBioFrontmatter, type SocialLink } from "@/lib/utils/bio";
import { useAsync } from "@/hooks/useAsync";
import { useSession } from "@/store/session";
import type { Article, CreatorDetail, Subscription } from "@/lib/api/types";

/** Icon per canonical social platform key, falling back to a plain link glyph. */
const SOCIAL_ICONS: Record<SocialLink["key"], LucideIcon> = {
  twitter: Twitter,
  github: Github,
  instagram: Instagram,
  youtube: Youtube,
  facebook: Facebook,
  linkedin: Linkedin,
  reddit: Link2,
  telegram: Send,
  mastodon: Link2,
  nostr: Zap,
  website: Globe,
};

/** Deterministic violet→fuchsia banner gradient from the username. */
function bannerGradient(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h << 5) - h + seed.charCodeAt(i);
  const a = Math.abs(h) % 360;
  const b = (a + 42) % 360;
  return `linear-gradient(120deg, hsl(${a} 65% 40% / 0.85), hsl(${b} 70% 30% / 0.85))`;
}

export default function CreatorFeature() {
  const { username = "" } = useParams<{ username: string }>();
  const { data, loading, error } = useAsync<CreatorDetail>(
    () => discover.creator(username),
    [username],
  );

  if (loading) return <CreatorSkeleton />;

  if (error || !data) {
    return (
      <div className="animate-slide-up">
        <BackLink />
        <EmptyState
          className="mt-6"
          icon={UserX}
          title="Creator not found"
          description={`We couldn't find a creator at @${username}. The profile may have been removed.`}
          action={
            <Button asChild variant="outline">
              <Link to="/search">Back to search</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return <CreatorProfile creator={data} />;
}

function CreatorProfile({ creator }: { creator: CreatorDetail }) {
  const name = creator.display_name || creator.username;
  const { data: pages, loading: pagesLoading } = useAsync<Article[]>(
    () => discover.creatorPages(creator.username),
    [creator.username],
  );
  const { body: bio, socials } = useMemo(
    () => parseBioFrontmatter(creator.bio),
    [creator.bio],
  );
  // "Watch live" must only appear when this creator is ACTUALLY live right now.
  // Gate it on the server-computed `is_live` from the creator payload so the
  // button renders instantly with NO probe on mount. See `useLiveGate` for the
  // graceful fallback (older backend) and the light poll that keeps it accurate.
  const isLive = useLiveGate(creator.username, creator.is_live);

  return (
    <div className="animate-slide-up pb-6">
      <BackLink />

      {/* Banner */}
      <div
        className="relative mt-4 h-40 w-full overflow-hidden rounded-xl border border-border md:h-56"
        style={
          creator.banner
            ? undefined
            : { backgroundImage: bannerGradient(creator.username) }
        }
      >
        {creator.banner ? (
          <img
            src={creator.banner}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : null}
        <div className="absolute inset-0 bg-gradient-to-t from-background/70 to-transparent" />
      </div>

      {/* Header */}
      <div className="relative -mt-12 flex flex-col gap-4 px-1 sm:flex-row sm:items-end sm:justify-between md:px-4">
        <div className="flex items-end gap-4">
          <Avatar className="h-24 w-24 border-4 border-background shadow-md">
            {creator.image ? (
              <AvatarImage src={creator.image} alt={name} />
            ) : null}
            <AvatarFallback className="bg-primary/15 text-2xl text-primary">
              {initials(name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 pb-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-2xl font-bold tracking-tight md:text-3xl">
                {name}
              </h1>
              {creator.is_verified ? (
                <BadgeCheck
                  className="h-6 w-6 shrink-0 text-primary"
                  aria-label="Verified creator"
                />
              ) : null}
            </div>
            <div className="text-sm text-muted-foreground">
              @{creator.username}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <span className="tabular-nums">
                <span className="font-semibold text-foreground">
                  {creator.zpages}
                </span>{" "}
                {creator.zpages === 1 ? "page" : "pages"}
              </span>
              <span className="tabular-nums">
                <span className="font-semibold text-foreground">
                  {creator.total.toLocaleString()}
                </span>{" "}
                score
              </span>
              {/* `can_stream` is an INTERNAL streaming-eligibility flag we track
                  server-side — it is deliberately NOT surfaced to fans. Whether
                  a creator is *currently* live is a separate signal, handled by
                  the live-status probe on the "Watch live" action below. */}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 pb-1">
          {isLive ? (
            <Button asChild variant="outline">
              <Link
                to={`/live/${creator.username}`}
                aria-label={`Watch ${name} live`}
              >
                <Radio className="h-4 w-4" aria-hidden />
                Watch live
              </Link>
            </Button>
          ) : null}
          <TipButton creator={creator} />
          <SubscribeButton creator={creator} />
        </div>
      </div>

      {/* Bio */}
      {bio ? (
        <div className="mt-8 md:px-4">
          <div className="rounded-xl border border-border/60 bg-card/40 p-5">
            <Markdown>{bio}</Markdown>
          </div>
        </div>
      ) : null}

      {/* Links / socials — parsed from a frontmatter block at the top of the
          bio (e.g. `---\nsocials:\n  twitter: handle\n---`). */}
      {socials.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2 md:px-4">
          {socials.map((social) => {
            const Icon = SOCIAL_ICONS[social.key];
            return (
              <a
                key={social.key}
                href={social.url}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={`${name} on ${social.label}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card/40 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              >
                <Icon className="h-3.5 w-3.5" aria-hidden />
                {social.display}
              </a>
            );
          })}
        </div>
      ) : null}

      {/* Pages */}
      <div className="mt-10 md:px-4">
        <h2 className="mb-4 text-lg font-semibold tracking-tight">
          Pages by {name}
        </h2>
        {pagesLoading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <PageCardSkeleton key={i} />
            ))}
          </div>
        ) : !pages || pages.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No pages yet"
            description={`${name} hasn't published any pages yet.`}
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {pages.map((p) => (
              <PageCard key={String(p.id)} article={p} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Resolve whether a creator is live, fast AND accurate:
 *
 *  1. **Instant** — seed state from `payloadIsLive` (the server-computed
 *     `is_live` on the creator payload), so the very first render gates
 *     "Watch live" correctly with NO network request on mount.
 *  2. **Graceful fallback** — if the payload omits the field (`undefined`,
 *     e.g. an older backend mid-deploy), probe the cheap `live.status`
 *     endpoint once on mount so nothing breaks during the deploy window.
 *  3. **Accurate over time** — a creator can go live/offline while the profile
 *     is open, so poll the same light `live.status` endpoint on a 30s interval
 *     and correct the button. We never refetch the heavy creator profile here.
 *
 * The interval and in-flight guard are torn down on unmount / username change,
 * so navigating away leaves no lingering timers or requests.
 */
const LIVE_POLL_MS = 30_000;

function useLiveGate(
  username: string,
  payloadIsLive: boolean | undefined,
): boolean {
  // Initialise from the payload so the first paint is already correct.
  const [isLive, setIsLive] = useState<boolean>(payloadIsLive ?? false);
  // Track whether THIS mount has ever had a definitive answer, so an initial
  // `undefined` payload triggers the fallback probe immediately.
  const hasPayload = payloadIsLive !== undefined;

  useEffect(() => {
    // Reset to the payload value whenever we switch creators (or the payload
    // arrives) — keeps the instant gate correct without waiting on a probe.
    setIsLive(payloadIsLive ?? false);

    let alive = true;
    const probe = async () => {
      try {
        const s = await live.status(username);
        if (alive) setIsLive(s.live);
      } catch {
        // Keep the last known value on a failed probe rather than flicker.
      }
    };

    // Fallback: only probe on mount when the payload couldn't tell us.
    if (!hasPayload) void probe();

    // Light poll keeps the button accurate while the profile stays mounted.
    const timer = setInterval(probe, LIVE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [username, payloadIsLive, hasPayload]);

  return isLive;
}

// ─── Subscribe ────────────────────────────────────────────────────────────────
/** "Aug 14" style short date for a membership renewal/expiry. */
function formatMembershipDate(iso?: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function SubscribeButton({ creator }: { creator: CreatorDetail }) {
  const name = creator.display_name || creator.username;
  const navigate = useNavigate();
  const user = useSession((s) => s.user);
  const balance = useSession((s) => s.tuzis);
  const adjustTuzis = useSession((s) => s.adjustTuzis);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Set the instant `subscribe()` succeeds so the button reflects the new
  // state immediately, even before `reloadSubscriptions` below lands (and
  // even if that refetch fails) — see the comment on `tuzi.mySubscriptions`
  // for why this is the only backend source of subscription status.
  const [justSubscribed, setJustSubscribed] = useState<Subscription | null>(
    null,
  );
  // Cancelling / resuming only flips auto-renew server-side (DELETE sets
  // `max_price` to 0; a fresh POST restores it) — the membership ROW lives on
  // until `expires`, so `mySubscriptions` keeps returning it either way. These
  // two optimistic overrides let the dialog reflect the user's latest action
  // instantly, before the background `reloadSubscriptions` refetch lands.
  const [renewOverride, setRenewOverride] = useState<boolean | null>(null);
  // For a free follow there's no "access until expires" — unfollowing should
  // remove the follow outright. But the backend/mock keeps the row (DELETE only
  // stops renewal), so we track the unfollow intent locally to drop the follow
  // from the UI immediately and keep it dropped across the refetch.
  const [unfollowed, setUnfollowed] = useState(false);

  const price = creator.member_price ?? 0;
  const enough = price <= balance;

  const { data: subscriptions, reload: reloadSubscriptions } = useAsync<
    Subscription[]
  >(
    () => (user ? tuzi.mySubscriptions() : Promise.resolve([])),
    [user?.username, creator.username],
  );
  const remoteSub = subscriptions?.find(
    (s) => s.star.username.toLowerCase() === creator.username.toLowerCase(),
  );
  const sub = remoteSub ?? justSubscribed;
  const subscribed = unfollowed ? false : Boolean(sub);
  // `max_price === 0` means the fan cancelled auto-renew (DELETE
  // /api/tuzis/subscribe/{username}) — access still runs to `expires`, it
  // just won't recur. `renewOverride` reflects a just-issued cancel/resume
  // before the refetch confirms it.
  const renewing =
    renewOverride ?? (sub ? Number(sub.max_price ?? 0) > 0 : true);

  // A fresh subscribe and a resume-renewal are the same backend call — POST
  // /api/tuzis/subscribe/{username} get-or-creates the membership and (re)sets
  // renewal at the current price — so they share one runner and differ only in
  // the copy and whether the dialog stays open to show the flipped state.
  async function runSubscribe(mode: "subscribe" | "resume") {
    if (!user) {
      navigate("/login");
      return;
    }
    setBusy(true);
    try {
      await tuzi.subscribe(creator.username);
      // Debit only after the POST succeeds, and only for a paid tier — never
      // credit/debit on failure.
      if (price > 0) adjustTuzis(-price);
      const expires = new Date(Date.now() + 30 * 86400000).toISOString();
      setUnfollowed(false);
      if (mode === "resume") setRenewOverride(true);
      setJustSubscribed({
        fan: {
          username: user.username,
          free2zaddr: user.free2zaddr ?? user.username,
        },
        star: { username: creator.username, free2zaddr: creator.free2zaddr },
        expires,
        max_price: String(price),
      });
      if (mode === "resume") {
        toast.success(`Auto-renew resumed for ${name}`, {
          description:
            price > 0
              ? `Your membership renews monthly · ${formatTuzis(price)}.`
              : `Your membership will keep renewing.`,
        });
        // Keep the dialog open so it re-renders into the resumed state.
      } else {
        toast.success(`Subscribed to ${name}`, {
          description:
            price > 0
              ? `Renews monthly · ${formatTuzis(price)}. You've unlocked ${name}'s subscriber posts and livestreams.`
              : `You've unlocked ${name}'s subscriber posts and livestreams.`,
        });
        setOpen(false);
      }
      void reloadSubscriptions();
    } catch {
      toast.error(
        mode === "resume"
          ? "Couldn't resume auto-renew. Please try again."
          : "Couldn't complete the subscription. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  const subscribe = () => runSubscribe("subscribe");
  const resumeRenewal = () => runSubscribe("resume");

  // Paid tier: cancel auto-renew. Access continues to `expires`; only renewal
  // stops. The dialog stays open so it re-renders into the "Resume renewal"
  // state.
  async function cancelRenewal() {
    setBusy(true);
    try {
      await tuzi.unsubscribe(creator.username);
      setRenewOverride(false);
      setJustSubscribed(null);
      toast.success("Membership won't renew", {
        description: sub?.expires
          ? `You'll keep access to ${name}'s subscriber posts and livestreams until ${formatMembershipDate(sub.expires)}.`
          : undefined,
      });
      void reloadSubscriptions();
    } catch {
      toast.error("Couldn't update your membership. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  // Free follow: undo the follow entirely.
  async function unfollow() {
    setBusy(true);
    try {
      await tuzi.unsubscribe(creator.username);
      setUnfollowed(true);
      setJustSubscribed(null);
      toast.success(`Unfollowed ${name}`);
      void reloadSubscriptions();
    } catch {
      toast.error("Couldn't unfollow. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!creator.member_price) {
    // No paid tier — a plain follow/unfollow toggle.
    return (
      <Button
        variant={subscribed ? "secondary" : "default"}
        onClick={subscribed ? unfollow : subscribe}
        disabled={busy}
        aria-label={
          subscribed ? `Unfollow ${name}` : `Follow ${name}`
        }
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : subscribed ? (
          <Check className="h-4 w-4" aria-hidden />
        ) : null}
        {subscribed ? "Following" : "Subscribe"}
      </Button>
    );
  }

  if (subscribed) {
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button
            variant="secondary"
            className="border border-primary/30 bg-primary/10 text-primary hover:bg-primary/15"
            aria-label={`Manage your ${name} membership`}
          >
            <Check className="h-4 w-4" aria-hidden />
            Member
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Your membership to {name}</DialogTitle>
            <DialogDescription>
              {renewing
                ? "Unlocks subscriber posts and livestreams. Renews automatically each month."
                : "Auto-renew is off — you'll keep access until it expires."}
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-xl border border-border bg-card/50 p-4">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-muted-foreground">
                Membership price
              </span>
              <span className="text-xl font-bold tabular-nums">
                {formatTuzis(price)}
                <span className="text-sm font-normal text-muted-foreground">
                  /mo
                </span>
              </span>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {renewing ? "Renews" : "Access ends"}{" "}
              {sub?.expires ? formatMembershipDate(sub.expires) : "soon"}
            </p>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Close
            </Button>
            {renewing ? (
              <Button
                variant="outline"
                onClick={cancelRenewal}
                disabled={busy}
                aria-label={`Turn off auto-renew for your ${name} membership`}
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : null}
                Cancel membership
              </Button>
            ) : enough ? (
              <Button
                onClick={resumeRenewal}
                disabled={busy}
                aria-label={`Resume auto-renew for your ${name} membership`}
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : null}
                Resume renewal
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={() => {
                  setOpen(false);
                  navigate("/buy");
                }}
              >
                Not enough 2Z — buy more
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button aria-label={`Subscribe to ${name} · ${formatTuzis(price)}/mo`}>
          Subscribe · {formatTuzis(price)}/mo
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Subscribe to {name}</DialogTitle>
          <DialogDescription>
            This is {name}'s membership price — what it costs you to become a
            subscriber. It unlocks their subscriber posts and livestreams for
            30 days.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border border-border bg-card/50 p-4">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-muted-foreground">
              Membership · monthly
            </span>
            <span className="text-xl font-bold tabular-nums">
              {formatTuzis(price)}
            </span>
          </div>
          <p className="mt-2 text-xs text-muted-foreground tabular-nums">
            Your balance: {formatTuzis(balance)}
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          {enough ? (
            <Button onClick={subscribe} disabled={busy}>
              {busy ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  Subscribing
                </>
              ) : (
                <>Subscribe · {formatTuzis(price)}</>
              )}
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={() => {
                setOpen(false);
                navigate("/buy");
              }}
            >
              Not enough 2Z — buy more
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Tip ──────────────────────────────────────────────────────────────────────
const TIP_PRESETS = [50, 100, 250, 500];

function TipButton({ creator }: { creator: CreatorDetail }) {
  const name = creator.display_name || creator.username;
  const navigate = useNavigate();
  const balance = useSession((s) => s.tuzis);
  const adjustTuzis = useSession((s) => s.adjustTuzis);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(100);
  const [busy, setBusy] = useState(false);

  const enough = amount <= balance;
  const canSend = amount > 0 && enough && !busy;

  async function send() {
    if (!canSend) return;
    setBusy(true);
    try {
      await tuzi.donate(creator.username, amount);
      adjustTuzis(-amount);
      toast.success(`Sent ${formatTuzis(amount)} to ${name}`);
      setOpen(false);
    } catch {
      toast.error("Could not send your tip. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" aria-label={`Tip ${name}`}>
          <Heart className="h-4 w-4" aria-hidden />
          Tip
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tip {name}</DialogTitle>
          <DialogDescription>
            Send 2Zs straight to the creator, from your platform credit balance.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-4 gap-2">
            {TIP_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setAmount(preset)}
                aria-pressed={amount === preset}
                className={cn(
                  "rounded-lg border px-3 py-2 text-sm font-medium tabular-nums transition-colors",
                  amount === preset
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border bg-transparent text-muted-foreground hover:bg-secondary",
                )}
              >
                {preset}
              </button>
            ))}
          </div>
          <div className="space-y-2">
            <Label htmlFor="creator-tip-amount">Amount (2Z)</Label>
            <Input
              id="creator-tip-amount"
              type="number"
              min={1}
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(Math.max(0, Number(e.target.value)))}
              className="tabular-nums"
            />
            <p className="text-xs text-muted-foreground tabular-nums">
              Balance: {formatTuzis(balance)}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          {amount > 0 && !enough ? (
            <Button
              variant="outline"
              onClick={() => {
                setOpen(false);
                navigate("/buy");
              }}
            >
              Not enough 2Z — buy more
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Button>
          ) : (
            <Button onClick={send} disabled={!canSend}>
              {busy ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  Sending
                </>
              ) : (
                <>Send {formatTuzis(amount)}</>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Page card ────────────────────────────────────────────────────────────────
function PageCard({ article }: { article: Article }) {
  return (
    <Link
      to={`/articles/${article.slug ?? article.id}`}
      aria-label={`Read “${article.title}”`}
      className="group flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card/60 transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="aspect-[16/9] w-full overflow-hidden bg-secondary">
        {article.image ? (
          <img
            src={article.image}
            alt=""
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="grid h-full w-full place-items-center text-muted-foreground">
            <FileText className="h-6 w-6" aria-hidden />
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <h3 className="line-clamp-2 font-semibold leading-snug group-hover:text-primary">
          {article.title}
        </h3>
        {article.subtitle ? (
          <p className="line-clamp-2 text-sm text-muted-foreground">
            {article.subtitle}
          </p>
        ) : null}
        <div className="mt-auto flex items-center gap-3 pt-2 text-xs text-muted-foreground">
          {typeof article.reading_minutes === "number" ? (
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" aria-hidden />
              {article.reading_minutes} min
            </span>
          ) : null}
          {article.published_at ? (
            <span>{timeAgo(article.published_at)}</span>
          ) : null}
        </div>
      </div>
    </Link>
  );
}

function PageCardSkeleton() {
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card/40">
      <Skeleton className="aspect-[16/9] w-full rounded-none" />
      <div className="space-y-2 p-4">
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-4 w-full" />
      </div>
    </div>
  );
}

/**
 * Context-aware back link: reaching a creator profile from an article byline
 * (or anywhere else in the app) should return to where the visitor came from,
 * not dump them on /search. `location.key === "default"` only for the very
 * first entry in the history stack (a direct link / fresh load), so that's
 * the one case with nowhere real to go back to.
 */
function BackLink() {
  const navigate = useNavigate();
  const location = useLocation();
  const hasHistory = location.key !== "default";

  if (hasHistory) {
    return (
      <button
        type="button"
        onClick={() => navigate(-1)}
        className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Back
      </button>
    );
  }

  return (
    <Link
      to="/search"
      className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden />
      Search
    </Link>
  );
}

function CreatorSkeleton() {
  return (
    <div className="animate-slide-up">
      <Skeleton className="h-4 w-20" />
      <Skeleton className="mt-4 h-40 w-full rounded-xl md:h-56" />
      <div className="relative -mt-12 flex items-end gap-4 px-1 md:px-4">
        <Skeleton className="h-24 w-24 rounded-full border-4 border-background" />
        <div className="space-y-2 pb-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-24" />
        </div>
      </div>
      <div className="mt-8 space-y-3 md:px-4">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  );
}
