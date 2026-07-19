import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Clock,
  FileText,
  Heart,
  Loader2,
  Radio,
  UserX,
} from "lucide-react";
import { toast } from "sonner";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
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
import { discover, tuzi } from "@/lib/api/free2z";
import { formatTuzis, initials, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useAsync } from "@/hooks/useAsync";
import { useSession } from "@/store/session";
import type { Article, CreatorDetail } from "@/lib/api/types";

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
              {creator.can_stream ? (
                <Badge variant="live">Can stream</Badge>
              ) : null}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 pb-1">
          {creator.can_stream ? (
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
      {creator.bio ? (
        <div className="mt-8 md:px-4">
          <div className="rounded-xl border border-border/60 bg-card/40 p-5">
            <Markdown>{creator.bio}</Markdown>
          </div>
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

// ─── Subscribe ────────────────────────────────────────────────────────────────
function SubscribeButton({ creator }: { creator: CreatorDetail }) {
  const name = creator.display_name || creator.username;
  const navigate = useNavigate();
  const user = useSession((s) => s.user);
  const balance = useSession((s) => s.tuzis);
  const adjustTuzis = useSession((s) => s.adjustTuzis);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const price = creator.member_price ?? 0;
  const enough = price <= balance;

  async function subscribe() {
    if (!user) {
      navigate("/login");
      return;
    }
    setBusy(true);
    try {
      await tuzi.subscribe(creator.username);
      if (price > 0) adjustTuzis(-price);
      toast.success(`Subscribed to ${name}`);
      setOpen(false);
    } catch {
      toast.error("Couldn't complete the subscription. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!creator.member_price) {
    // No paid tier — a plain follow/subscribe.
    return (
      <Button onClick={subscribe} disabled={busy}>
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : null}
        Subscribe
      </Button>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button aria-label={`Subscribe to ${name}`}>Subscribe</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Subscribe to {name}</DialogTitle>
          <DialogDescription>
            Membership unlocks subscriber posts and livestreams for 30 days.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border border-border bg-card/50 p-4">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-muted-foreground">Monthly</span>
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

function BackLink() {
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
