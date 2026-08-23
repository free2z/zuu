import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Check,
  Clock,
  FileText,
  Heart,
  Loader2,
  Radio,
  UserX,
} from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
import { RemoteMedia } from "@/components/common/RemoteMedia";
import { SectionLoadError } from "@/components/common/SectionLoadError";
import { discover, live, tuzi } from "@/lib/api/free2z";
import {
  formatTuzis,
  initials,
  MAX_TUZIS,
  timeAgo,
  tuziInputExample,
  tuziInputMaxLength,
  validateTuzis,
} from "@/lib/format";
import { coverTone } from "@/lib/cover";
import { cn } from "@/lib/utils";
import { parseBioFrontmatter } from "@/lib/utils/bio";
import {
  currentResourceData,
  isConfirmedNotFound,
  type KeyedRemoteData,
} from "@/lib/remote-data";
import { useAsync } from "@/hooks/useAsync";
import { usePaidIntent } from "@/hooks/usePaidIntent";
import { useSession } from "@/store/session";
import type { Article, CreatorDetail, Subscription } from "@/lib/api/types";
import { paidActionGate } from "@/lib/auth/paid-action";
import { preservePaidIntent, type PaidIntent } from "@/lib/auth/paid-intent";
import { CreatorSocialLinks } from "./SocialLinks";
import { useCreatorCatalog } from "./catalog";

export default function CreatorFeature() {
  const { username = "" } = useParams<{ username: string }>();
  const { data, loading, error, reload } = useAsync<
    KeyedRemoteData<string, CreatorDetail>
  >(
    async () => ({
      key: username,
      value: await discover.creator(username),
    }),
    [username],
  );
  const creator = currentResourceData(data, username);

  if (loading && creator === null && !error) return <CreatorSkeleton />;

  if (error && creator === null) {
    if (!isConfirmedNotFound(error)) {
      return (
        <div className="animate-slide-up">
          <BackLink />
          <SectionLoadError
            className="mt-6"
            title="Couldn't load this creator"
            description="The profile may still be available. Check your connection and try again."
            retry={reload}
            retrying={loading}
          />
        </div>
      );
    }

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

  if (!creator) {
    return (
      <div className="animate-slide-up">
        <BackLink />
        <SectionLoadError
          className="mt-6"
          title="Couldn't load this creator"
          description="The server returned no profile. Try again."
          retry={reload}
          retrying={loading}
        />
      </div>
    );
  }

  return (
    <CreatorProfile
      key={creator.username}
      creator={creator}
      refreshError={error}
      refresh={reload}
      refreshing={loading}
    />
  );
}

function CreatorProfile({
  creator,
  refreshError,
  refresh,
  refreshing,
}: {
  creator: CreatorDetail;
  refreshError: unknown | null;
  refresh: () => void;
  refreshing: boolean;
}) {
  const name = creator.display_name || creator.username;
  const location = useLocation();
  const restoredPaidIntent = usePaidIntent(location.pathname, [
    "creator-subscription",
    "creator-tip",
  ]);
  const pages = useCreatorCatalog(creator.username, creator.zpages);
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
    <div
      className="creator-profile animate-slide-up pb-6"
      data-creator-profile
    >
      <BackLink />

      {refreshError ? (
        <SectionLoadError
          className="mt-4"
          title="Couldn't refresh this profile"
          description="Showing the last version loaded on this device."
          retry={refresh}
          retrying={refreshing}
          stale
        />
      ) : null}

      {/* Banner */}
      <div
        className="creator-profile-banner relative mt-4 h-40 w-full overflow-hidden rounded-xl border border-border"
        style={
          creator.banner
            ? undefined
            : { backgroundImage: coverTone(creator.username) }
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
      <div
        className="creator-profile-header relative -mt-12 flex flex-col gap-4 px-1"
        data-creator-profile-header
      >
        <div className="flex min-w-0 items-end gap-4" data-creator-identity>
          <Avatar className="h-24 w-24 border-4 border-background shadow-md">
            {creator.image ? (
              <AvatarImage src={creator.image} alt={name} />
            ) : null}
            <AvatarFallback className="bg-secondary text-2xl text-muted-foreground">
              {initials(name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 pb-1">
            <div className="flex items-center gap-2">
              <h1 className="creator-profile-name min-w-0 break-words text-2xl font-bold tracking-tight">
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
        <div
          className="creator-profile-actions flex min-w-0 flex-wrap items-center gap-2 pb-1"
          data-creator-actions
        >
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
          <TipButton creator={creator} restored={restoredPaidIntent} />
          <SubscribeButton creator={creator} restored={restoredPaidIntent} />
        </div>
      </div>

      {/* Bio */}
      {bio ? (
        <div className="creator-profile-inset mt-8">
          <div className="rounded-xl border border-border/60 bg-card/40 p-5">
            <Markdown>{bio}</Markdown>
          </div>
        </div>
      ) : null}

      {/* Links / socials — parsed from a frontmatter block at the top of the
          bio (e.g. `---\nsocials:\n  twitter: handle\n---`). */}
      <CreatorSocialLinks creatorName={name} socials={socials} />

      {/* Pages */}
      <div className="creator-profile-inset mt-10" data-creator-pages>
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold tracking-tight">
            Pages by {name}
          </h2>
          <span
            className="text-sm tabular-nums text-muted-foreground"
            aria-live="polite"
          >
            {pages.items.length} of {creator.zpages}
          </span>
        </div>
        {pages.error ? (
          <SectionLoadError
            className="mb-4"
            title={
              pages.items.length === 0
                ? "Couldn't load this creator's pages"
                : "Couldn't load more of this creator's pages"
            }
            description={
              pages.items.length === 0
                ? "The published pages are temporarily unavailable."
                : "The pages already loaded are still available."
            }
            retry={pages.retry}
            retrying={pages.loading}
            stale={pages.items.length > 0}
          />
        ) : null}
        {pages.loading && !pages.initialized && pages.items.length === 0 ? (
          <div className="creator-pages-grid grid grid-cols-1 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <PageCardSkeleton key={i} />
            ))}
          </div>
        ) : pages.error && pages.items.length === 0 ? null : creator.zpages ===
          0 ? (
          <EmptyState
            icon={FileText}
            title="No pages yet"
            description={`${name} hasn't published any pages yet.`}
          />
        ) : pages.items.length > 0 ? (
          <>
            <div className="creator-pages-grid grid grid-cols-1 gap-4">
              {pages.items.map((p) => (
                <PageCard key={String(p.id)} article={p} />
              ))}
            </div>
            {pages.next !== null && !pages.error ? (
              <div className="mt-5 flex justify-center">
                <Button
                  type="button"
                  variant="outline"
                  onClick={pages.loadMore}
                  disabled={pages.loading}
                >
                  {pages.loading ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : null}
                  {pages.loading ? "Loading pages" : "Load more pages"}
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
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

function SubscribeButton({
  creator,
  restored,
}: {
  creator: CreatorDetail;
  restored: PaidIntent | null;
}) {
  const name = creator.display_name || creator.username;
  const navigate = useNavigate();
  const location = useLocation();
  const user = useSession((s) => s.user);
  const sessionLoading = useSession((s) => s.loading);
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

  useEffect(() => {
    if (
      restored?.kind === "creator-subscription" &&
      restored.subject === creator.username
    ) {
      setOpen(true);
    }
  }, [creator.username, restored]);

  const price = creator.member_price ?? 0;
  const gate = paidActionGate({
    sessionLoading,
    user,
    balance,
    cost: price,
  });

  function signInToSubscribe() {
    const returnTo = preservePaidIntent(location.pathname, {
      kind: "creator-subscription",
      subject: creator.username,
    });
    navigate("/login", { state: { returnTo } });
  }

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
    const currentUser = useSession.getState().user;
    if (!currentUser || gate === "sign-in") {
      signInToSubscribe();
      return;
    }
    if (gate !== "ready") return;
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
          username: currentUser.username,
          free2zaddr: currentUser.free2zaddr ?? currentUser.username,
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
    if (!useSession.getState().user) {
      signInToSubscribe();
      return;
    }
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
    if (!useSession.getState().user) {
      signInToSubscribe();
      return;
    }
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
        disabled={busy || gate === "loading"}
        aria-label={subscribed ? `Unfollow ${name}` : `Follow ${name}`}
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
            <Button
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              Close
            </Button>
            {gate === "loading" ? (
              <Button disabled>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Checking account
              </Button>
            ) : gate === "sign-in" ? (
              <Button onClick={signInToSubscribe}>Sign in to manage</Button>
            ) : renewing ? (
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
            ) : gate === "ready" ? (
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
                  navigate("/wallet/fund");
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
            subscriber. It unlocks their subscriber posts and livestreams for 30
            days.
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
          {user ? (
            <p className="mt-2 text-xs text-muted-foreground tabular-nums">
              Your balance: {formatTuzis(balance)}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          {gate === "loading" ? (
            <Button disabled>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Checking account
            </Button>
          ) : gate === "sign-in" ? (
            <Button onClick={signInToSubscribe}>Sign in to subscribe</Button>
          ) : gate === "ready" ? (
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
                navigate("/wallet/fund");
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

function TipButton({
  creator,
  restored,
}: {
  creator: CreatorDetail;
  restored: PaidIntent | null;
}) {
  const name = creator.display_name || creator.username;
  const navigate = useNavigate();
  const location = useLocation();
  const user = useSession((s) => s.user);
  const sessionLoading = useSession((s) => s.loading);
  const balance = useSession((s) => s.tuzis);
  const adjustTuzis = useSession((s) => s.adjustTuzis);
  const restoredTip =
    restored?.kind === "creator-tip" && restored.subject === creator.username
      ? restored
      : null;
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("100");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!restoredTip) return;
    setAmount(restoredTip.amount);
    setOpen(true);
  }, [restoredTip]);

  const amountResult = validateTuzis(amount, {
    minimum: 1,
    maximum: MAX_TUZIS,
  });
  const parsedAmount = amountResult.value;
  const validAmount = amountResult.error === null;
  const gate = paidActionGate({
    sessionLoading,
    user,
    balance,
    cost: validAmount ? parsedAmount : null,
  });
  const canSend = validAmount && gate === "ready" && !busy;

  function signInToTip() {
    const returnTo = preservePaidIntent(location.pathname, {
      kind: "creator-tip",
      subject: creator.username,
      amount,
    });
    navigate("/login", { state: { returnTo } });
  }

  async function send() {
    if (!useSession.getState().user || gate === "sign-in") {
      signInToTip();
      return;
    }
    if (!canSend || parsedAmount === null) return;
    setBusy(true);
    try {
      await tuzi.donate(creator.username, parsedAmount);
      adjustTuzis(-parsedAmount);
      toast.success(`Sent ${formatTuzis(parsedAmount)} to ${name}`);
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
                onClick={() => setAmount(String(preset))}
                aria-pressed={parsedAmount === preset}
                className={cn(
                  "min-tap rounded-lg border px-3 py-2 text-sm font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  parsedAmount === preset
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
              type="text"
              inputMode="numeric"
              maxLength={tuziInputMaxLength(MAX_TUZIS)}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="tabular-nums"
              aria-describedby={
                user
                  ? "creator-tip-error creator-tip-balance"
                  : "creator-tip-error"
              }
              aria-invalid={amount.length > 0 && !validAmount}
            />
            {user ? (
              <p
                id="creator-tip-balance"
                className="text-xs text-muted-foreground tabular-nums"
              >
                Balance: {formatTuzis(balance)}
              </p>
            ) : null}
            <p
              id="creator-tip-error"
              className="min-h-[1rem] text-xs text-destructive"
            >
              {amountResult.error === "tooLarge"
                ? `Max ${MAX_TUZIS.toLocaleString()} 2Z per tip.`
                : amount.length > 0 && amountResult.error !== null
                  ? `Enter a positive whole 2Z amount, e.g. ${tuziInputExample()}.`
                  : null}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          {gate === "loading" ? (
            <Button disabled>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Checking account
            </Button>
          ) : gate === "sign-in" ? (
            <Button onClick={signInToTip}>Sign in to tip</Button>
          ) : validAmount && gate === "low-balance" ? (
            <Button
              variant="outline"
              onClick={() => {
                setOpen(false);
                navigate("/wallet/fund");
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
                <>
                  Send{" "}
                  {parsedAmount !== null ? formatTuzis(parsedAmount) : "2Zs"}
                </>
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
    <div
      className="group flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card/60 transition-colors hover:border-primary/40"
      data-creator-page-card
    >
      <div className="aspect-[16/9] w-full overflow-hidden bg-secondary">
        {article.image ? (
          <RemoteMedia
            source={article.image}
            kind="image"
            className="h-full min-h-0 rounded-none border-0 p-0"
          >
            {({ url }) => (
              <Link
                to={`/articles/${article.slug ?? article.id}`}
                aria-label={`Read “${article.title}”`}
                className="block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <img
                  src={url}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                />
              </Link>
            )}
          </RemoteMedia>
        ) : (
          <div className="grid h-full w-full place-items-center text-muted-foreground">
            <FileText className="h-6 w-6" aria-hidden />
          </div>
        )}
      </div>
      <Link
        to={`/articles/${article.slug ?? article.id}`}
        aria-label={`Read “${article.title}”`}
        className="flex flex-1 flex-col gap-2 rounded-md p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <h3
          className="line-clamp-2 font-semibold leading-snug group-hover:text-primary"
          data-user-content
        >
          {article.title}
        </h3>
        {article.subtitle ? (
          <p className="line-clamp-2 text-sm text-muted-foreground" data-user-content>
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
      </Link>
    </div>
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
        className="min-tap inline-flex items-center gap-2 rounded-md text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Back
      </button>
    );
  }

  return (
    <Link
      to="/search"
      className="min-tap inline-flex items-center gap-2 rounded-md text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
