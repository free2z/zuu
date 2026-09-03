import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Users,
  Radio,
  Lock,
  Loader2,
  Coins,
  Sparkles,
  LogOut,
  ShieldCheck,
  KeyRound,
  Copy,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/common/EmptyState";
import { SectionLoadError } from "@/components/common/SectionLoadError";
import { BidiIdentifier } from "@/components/common/BidiIdentifier";
import { auth, live, tuzi } from "@/lib/api/free2z";
import { ApiError } from "@/lib/api/http";
import { paidActionGate } from "@/lib/auth/paid-action";
import { preservePaidIntent } from "@/lib/auth/paid-intent";
import { useAsync } from "@/hooks/useAsync";
import { usePaidIntent } from "@/hooks/usePaidIntent";
import { useSession } from "@/store/session";
import { formatTuzis, timeAgo, initials } from "@/lib/format";
import type { DyteJoinTicket, Livestream, StreamKind } from "@/lib/api/types";
import { coverTone } from "@/lib/cover";
import { participantCountCopy } from "@/lib/participant-count";
import {
  parsePrivateInviteHash,
  privateInviteDisplayUrl,
} from "@/lib/private-live";
import { API_BASE } from "@/lib/env";
import { isTauri } from "@/lib/platform";
import { KIND_META } from "./lib";
import {
  enterSubscriberStream,
  MembershipPriceChangedError,
  newMembershipIdempotencyKey,
  runSingleFlight,
} from "./membership";
import { Stage } from "./Stage";
import { viewerEntryState } from "./viewer-safety";
import { classifyLiveFailure, safeLiveDiagnostic } from "./connection-failure";

interface JustStarted {
  ticket: DyteJoinTicket;
  inviteSecret?: string;
  kind: StreamKind;
  title: string;
  price_tuzis: number;
}

export function Room() {
  const { username = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const justStarted = (location.state as { justStarted?: JustStarted } | null)
    ?.justStarted;
  const inviteSecret = parsePrivateInviteHash(location.hash);
  const privateInviteAttempt = location.hash.startsWith("#private=");

  const tuzis = useSession((s) => s.tuzis);
  const adjustTuzis = useSession((s) => s.adjustTuzis);
  const user = useSession((s) => s.user);
  const sessionLoading = useSession((s) => s.loading);

  // A host who just went live already has their stream + ticket in navigation
  // state, so we can render the room immediately and skip the public listing
  // fetch entirely — keeping the heavy request off the "Go live" entrance frame
  // so the transition stays smooth. Only a cold visitor (deep link) needs the
  // listing to resolve which stream this is.
  const { data, loading, error, reload } = useAsync(async () => {
    if (justStarted) return { streams: [] as Livestream[], inviteTicket: null };
    if (privateInviteAttempt && !inviteSecret) {
      throw new Error("Invalid private invite");
    }
    if (inviteSecret) {
      const isHost =
        useSession.getState().user?.username.toLowerCase() ===
        username.toLowerCase();
      return {
        streams: [] as Livestream[],
        inviteTicket: await live.join(
          username,
          "private",
          inviteSecret,
          isHost ? "host" : "participant",
        ),
      };
    }
    return { streams: await live.listPublic(), inviteTicket: null };
  }, [justStarted, inviteSecret, privateInviteAttempt, username]);

  // Resolve the stream: prefer the public listing; otherwise synthesize one
  // from the just-started host session (creator's own stream isn't public
  // until it's discoverable).
  const stream = useMemo<Livestream | null>(() => {
    const found = (data?.streams ?? []).find((s) => s.username === username);
    if (found) return found;
    if (justStarted || data?.inviteTicket) {
      const currentUserIsCreator =
        user?.username.toLowerCase() === username.toLowerCase();
      const resolved = justStarted ?? {
        ticket: data!.inviteTicket!,
        kind: "private" as const,
        title: "Private call",
        price_tuzis: 0,
      };
      return {
        id: `local-${username}`,
        username,
        creator: {
          username,
          free2zaddr: username,
          display_name: currentUserIsCreator
            ? (user?.display_name ?? username)
            : username,
          image: currentUserIsCreator ? (user?.image ?? null) : null,
        },
        title: resolved.title,
        kind: resolved.kind,
        live: true,
        // Starting or joining locally does not reveal an authoritative room
        // count. Never synthesize the host/viewer into this value.
        participants: null,
        price_tuzis: resolved.price_tuzis,
        thumbnail: null,
        started_at: new Date().toISOString(),
      };
    }
    return null;
  }, [data, username, justStarted, user]);

  // Connection ticket, set once the viewer/host is in.
  const [ticket, setTicket] = useState<DyteJoinTicket | null>(
    justStarted?.ticket ?? null,
  );
  // Private invites remain memory-only. Keeping the active secret here lets a
  // failed viewer request obtain a fresh ticket without putting it in storage,
  // diagnostics, query parameters, or the ticket itself.
  const [activeJoinSecret, setActiveJoinSecret] = useState<string | undefined>(
    inviteSecret ?? undefined,
  );

  useEffect(() => {
    if (!data?.inviteTicket) return;
    const isHost = user?.username.toLowerCase() === username.toLowerCase();
    setTicket(
      isHost && data.inviteTicket.as !== "host"
        ? { ...data.inviteTicket, as: "host" }
        : data.inviteTicket,
    );
  }, [data?.inviteTicket, user?.username, username]);

  if (loading && !stream && !error) {
    return <RoomSkeleton />;
  }

  if (error && !stream) {
    if (privateInviteAttempt) {
      return (
        <div className="space-y-6">
          <BackLink />
          <EmptyState
            icon={Lock}
            title="Private room unavailable"
            description="This invite is wrong, expired, or the room has ended. No room details were disclosed."
            action={
              <Button variant="outline" onClick={reload} disabled={loading}>
                Try invite again
              </Button>
            }
          />
        </div>
      );
    }
    return (
      <div className="space-y-6">
        <BackLink />
        <SectionLoadError
          title="Couldn't load this stream"
          description="The stream may still be available. Check your connection and try again."
          retry={reload}
          retrying={loading}
        />
      </div>
    );
  }

  if (!stream) {
    return (
      <div className="space-y-6">
        <BackLink />
        <EmptyState
          icon={Radio}
          title="Stream unavailable"
          description={`There is no active public stream listed for @${username}. It may have ended.`}
          action={
            <Button asChild variant="outline">
              <Link to="/live">Browse livestreams</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const kind = KIND_META[stream.kind] ?? KIND_META.broadcast;
  const creatorName = stream.creator.display_name ?? stream.creator.username;
  const seed = stream.username + stream.title;
  const entryState = viewerEntryState({
    sessionLoading,
    viewerUsername: user?.username,
    creatorUsername: stream.username,
    kind: stream.kind,
  });
  const participants = participantCountCopy(stream.participants);

  return (
    <div className="space-y-6 animate-slide-up">
      <BackLink />

      {error ? (
        <SectionLoadError
          title="Couldn't refresh this stream"
          description="Showing the last confirmed stream details."
          retry={reload}
          retrying={loading}
          stale
        />
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          {/* Cinematic stage */}
          <div
            className="relative aspect-video w-full overflow-hidden rounded-2xl border border-border shadow-lg"
            style={{ background: coverTone(seed) }}
          >
            <div
              className="absolute inset-0 opacity-[0.12]"
              style={{
                backgroundImage:
                  "linear-gradient(rgba(255,255,255,.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.6) 1px, transparent 1px)",
                backgroundSize: "40px 40px",
              }}
              aria-hidden
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/20" />

            <div className="absolute start-4 top-4 flex flex-wrap items-center gap-2">
              {stream.live ? (
                <Badge variant="live" className="gap-1.5 shadow">
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-live animate-pulse-live"
                    aria-hidden
                  />
                  LIVE
                </Badge>
              ) : (
                <Badge variant="secondary">Offline</Badge>
              )}
              <Badge variant={kind.variant} className="gap-1">
                {stream.kind === "private" ? (
                  <Lock className="h-3 w-3" aria-hidden />
                ) : null}
                {kind.label}
              </Badge>
            </div>

            {stream.live ? (
              <div className="absolute end-4 top-4 flex items-center gap-1 rounded-full bg-black/55 px-2.5 py-1 text-xs font-medium text-white backdrop-blur">
                <Users className="h-3.5 w-3.5" aria-hidden />
                <span className="bidi-number tabular-nums">{participants.watching}</span>
              </div>
            ) : null}

            {/* Stage center: either the "off-air" identity or the real meeting */}
            {ticket ? (
              <Stage
                ticket={ticket}
                {...(ticket.as === "participant"
                  ? {
                      refreshTicket: (previous: DyteJoinTicket) =>
                        live.refreshParticipant(
                          stream.username,
                          stream.kind,
                          previous,
                          activeJoinSecret,
                        ),
                      onTicketRefreshed: setTicket,
                    }
                  : {})}
              />
            ) : (
              <div className="absolute inset-0 grid place-items-center">
                <div className="flex flex-col items-center gap-3 text-center">
                  <Avatar className="h-16 w-16 ring-2 ring-white/20">
                    {stream.creator.image ? (
                      <AvatarImage src={stream.creator.image} alt="" />
                    ) : null}
                    <AvatarFallback className="bg-black/40 text-lg text-white">
                      {initials(creatorName)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="text-sm font-medium text-white/90">
                    {stream.live ? "Live now" : "Not currently live"}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Title + creator */}
          <div className="space-y-3">
            <h1 className="text-xl font-bold leading-snug tracking-tight md:text-2xl">
              {stream.title}
            </h1>
            <div className="flex items-center gap-3">
              <Avatar className="h-10 w-10">
                {stream.creator.image ? (
                  <AvatarImage src={stream.creator.image} alt="" />
                ) : null}
                <AvatarFallback>{initials(creatorName)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <div className="break-words font-medium">{creatorName}</div>
                <div className="break-words text-xs text-muted-foreground">
                  @{stream.username}
                  {stream.live && stream.started_at
                    ? ` · started ${timeAgo(stream.started_at)}`
                    : ""}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right column: join gate OR connection details (the real meeting's
            own chat + participant panels live inside the Stage itself). */}
        <div className="space-y-4">
          {ticket ? (
            ticket.as === "host" ? (
              <HostControls
                stream={stream}
                inviteSecret={
                  justStarted?.inviteSecret ?? inviteSecret ?? undefined
                }
                onEnd={() => {
                  toast.success("Stream ended");
                  navigate("/live");
                }}
              />
            ) : (
              <ConnectedDetails
                ticket={ticket}
                stream={stream}
                onLeave={() => {
                  toast("You left the stream");
                  navigate("/live");
                }}
              />
            )
          ) : (
            entryState === "checking-session" ? (
              <ViewerIdentityCheck />
            ) : entryState === "creator-blocked" ? (
              <CreatorViewerGuard />
            ) : (
              <JoinPanel
                stream={stream}
                tuzis={tuzis}
                onJoined={(t, secret) => {
                  setActiveJoinSecret(secret);
                  setTicket(t);
                  if (stream.kind === "ppv" && stream.price_tuzis > 0) {
                    adjustTuzis(-stream.price_tuzis);
                  }
                }}
              />
            )
          )}
        </div>
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to="/live"
      className="min-tap inline-flex items-center gap-1.5 rounded-md text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowLeft className="rtl:-scale-x-100 h-4 w-4" aria-hidden />
      All livestreams
    </Link>
  );
}

function formatMembershipExpiry(expires?: string): string {
  if (!expires) return "";
  const date = new Date(expires);
  if (Number.isNaN(date.getTime())) return "";
  return ` until ${date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })}`;
}

function JoinPanel({
  stream,
  tuzis,
  onJoined,
}: {
  stream: Livestream;
  tuzis: number;
  onJoined: (ticket: DyteJoinTicket, secret?: string) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const kind = KIND_META[stream.kind] ?? KIND_META.broadcast;
  const restored = usePaidIntent(location.pathname, "live-entry");
  const restoredEntry =
    restored?.kind === "live-entry" && restored.subject === stream.username
      ? restored
      : null;
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [membershipConfirmOpen, setMembershipConfirmOpen] = useState(false);
  const [membershipPriceOverride, setMembershipPriceOverride] = useState<{
    price: number | null;
  } | null>(null);
  const [secret, setSecret] = useState("");
  const operationInFlight = useRef(false);
  // Keep this key through any ambiguous failure. A retry then asks the backend
  // to replay the same purchase instead of buying another month.
  const membershipAttemptKey = useRef<string | null>(null);
  const restoredEntryHandled = useRef(false);

  const user = useSession((state) => state.user);
  const sessionLoading = useSession((state) => state.loading);
  const setUser = useSession((state) => state.setUser);
  const {
    data: membershipStatus,
    loading: membershipLoading,
    error: membershipError,
    reload: reloadMemberships,
  } = useAsync(
    () =>
      user ? tuzi.subscriptionStatus(stream.username) : Promise.resolve(null),
    [user?.username, stream.username],
  );

  const price = stream.price_tuzis;
  const ppvGate = paidActionGate({
    sessionLoading,
    user,
    balance: tuzis,
    cost: price,
  });
  const membershipPrice =
    membershipPriceOverride !== null
      ? membershipPriceOverride.price
      : stream.creator.member_price;
  const hasMembershipPrice =
    Number.isSafeInteger(membershipPrice) && (membershipPrice ?? 0) > 0;
  const membershipAffordable =
    hasMembershipPrice && tuzis >= (membershipPrice ?? 0);
  const membership = membershipStatus?.active ? membershipStatus : null;

  function signInForEntry(mode: "ppv" | "subscriber") {
    const returnTo = preservePaidIntent(location.pathname, {
      kind: "live-entry",
      subject: stream.username,
      mode,
    });
    navigate("/login", { state: { returnTo } });
  }

  useEffect(() => {
    if (!restoredEntry || restoredEntryHandled.current || !user) return;
    if (restoredEntry.mode === "ppv") {
      if (ppvGate === "loading") return;
      restoredEntryHandled.current = true;
      if (ppvGate === "ready") setConfirmOpen(true);
      return;
    }
    if (membershipLoading) return;
    restoredEntryHandled.current = true;
    if (!membershipError && !membership && membershipAffordable) {
      setMembershipConfirmOpen(true);
    }
  }, [
    restoredEntry,
    user,
    ppvGate,
    membershipLoading,
    membershipError,
    membership,
    membershipAffordable,
  ]);

  async function runExclusive<T>(
    operation: () => Promise<T>,
  ): Promise<T | null> {
    // React state updates are not synchronous. The ref closes the double-click
    // window before the disabled button can render.
    return runSingleFlight(operationInFlight, async () => {
      setBusy(true);
      try {
        return await operation();
      } finally {
        setBusy(false);
      }
    });
  }

  async function doJoin(
    action?: () => Promise<void>,
    joinSecret?: string,
  ): Promise<boolean> {
    try {
      const ticket = await runExclusive(async () => {
        if (action) await action();
        return live.join(
          stream.username,
          stream.kind,
          joinSecret,
          "participant",
          { expectedMeetingId: stream.meetingId },
        );
      });
      if (!ticket) return false;
      onJoined(ticket, joinSecret);
      return true;
    } catch (e) {
      const failure = classifyLiveFailure(e, "ticket-request");
      console.warn("Livestream join failed", safeLiveDiagnostic(failure));
      toast.error("Could not join", {
        description: t(failure.messageKey),
      });
      return false;
    }
  }

  async function confirmPpv() {
    setConfirmOpen(false);
    if (!useSession.getState().user) {
      signInForEntry("ppv");
      return;
    }
    if (ppvGate !== "ready") return;
    const ok = await doJoin();
    if (ok) {
      // onJoined has already debited the balance; celebrate the entry.
      toast.success("You're in", {
        description: `Enjoy the stream — ${formatTuzis(price)} spent.`,
      });
    }
  }

  async function confirmMembership() {
    if (!useSession.getState().user) {
      signInForEntry("subscriber");
      return;
    }
    const alreadyActive = membership !== null;
    if (
      !alreadyActive &&
      (typeof membershipPrice !== "number" ||
        !Number.isSafeInteger(membershipPrice) ||
        membershipPrice <= 0)
    ) {
      return;
    }
    const confirmedPrice = alreadyActive
      ? Number(membership.current_price ?? 0)
      : membershipPrice!;
    setMembershipConfirmOpen(false);
    membershipAttemptKey.current ??= newMembershipIdempotencyKey();

    try {
      const result = await runExclusive(() =>
        enterSubscriberStream({
          username: stream.username,
          idempotencyKey: membershipAttemptKey.current!,
          confirmedPrice,
          authorization: alreadyActive ? "join-only" : "purchase-approved",
          loadMembership: () => tuzi.subscriptionStatus(stream.username),
          subscribe: (username, idempotencyKey, expectedPrice) =>
            tuzi.subscribeConfirmed(username, idempotencyKey, expectedPrice),
          reconcileBalance: async () => {
            const authoritative = await auth.me();
            // Preserve session-only identity observations that GET /auth/user
            // does not expose while replacing all authoritative account data.
            setUser({ ...useSession.getState().user, ...authoritative });
          },
          join: () =>
            live.join(stream.username, stream.kind, undefined, "participant", {
              expectedMeetingId: stream.meetingId,
            }),
        }),
      );
      if (!result) return;

      membershipAttemptKey.current = null;
      onJoined(result.ticket);
      const renews = Number(result.membership.max_price ?? 0) > 0;
      toast.success("You're in", {
        description:
          result.purchase?.charged === true
            ? `${formatTuzis(confirmedPrice)} paid. Auto-renew is ${renews ? "on" : "off"}.`
            : result.purchase !== null || result.recoveredAmbiguousPurchase
              ? "Your membership and balance were verified before joining."
              : "Your active membership was verified. No membership purchase was made.",
      });
    } catch (error) {
      // The key intentionally survives: if the POST committed but its response
      // was lost, retrying reconciles/replays instead of charging again.
      reloadMemberships();
      let displayError = error;
      if (
        error instanceof ApiError &&
        error.body &&
        typeof error.body === "object"
      ) {
        const body = error.body as Record<string, unknown>;
        if (body.code === "price_changed") {
          const rawPrice = body.current_price;
          const currentPrice =
            typeof rawPrice === "string" &&
            Number.isSafeInteger(Number(rawPrice))
              ? Number(rawPrice)
              : null;
          setMembershipPriceOverride({ price: currentPrice });
          displayError = new MembershipPriceChangedError(
            confirmedPrice,
            currentPrice,
          );
        }
      }
      toast.error("Could not confirm membership", {
        description:
          displayError instanceof Error
            ? displayError.message
            : "Please try again.",
      });
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="space-y-1 border-b border-border p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold">Join this stream</span>
          <Badge variant={kind.variant} className="gap-1">
            {stream.kind === "private" ? (
              <Lock className="h-3 w-3" aria-hidden />
            ) : null}
            {kind.short}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">{kind.blurb}</p>
      </div>

      <div className="space-y-4 p-4">
        {/* BROADCAST */}
        {stream.kind === "broadcast" ? (
          <Button
            className="w-full gap-2"
            size="lg"
            disabled={busy}
            onClick={() => doJoin()}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Radio className="h-4 w-4" aria-hidden />
            )}
            Join free
          </Button>
        ) : null}

        {/* SUBSCRIBER */}
        {stream.kind === "subscriber" ? (
          <>
            <p className="text-xs text-muted-foreground">
              This stream is for members of{" "}
              <span className="font-medium text-foreground">
                @{stream.username}
              </span>
              . Active members join without another purchase.
            </p>

            <div className="space-y-2 rounded-lg border border-border bg-background/50 px-3 py-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Creator</span>
                <span className="font-medium">
                  {stream.creator.display_name ?? `@${stream.username}`}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Membership</span>
                <span className="font-semibold bidi-number tabular-nums">
                  {hasMembershipPrice
                    ? `${formatTuzis(membershipPrice!)}/30 days`
                    : "Unavailable"}
                </span>
              </div>
              {user ? (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Current balance</span>
                  <span className="font-medium bidi-number tabular-nums">
                    {formatTuzis(tuzis)}
                  </span>
                </div>
              ) : null}
            </div>

            {sessionLoading || (user && membershipLoading) ? (
              <Button className="w-full gap-2" size="lg" disabled>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Checking membership
              </Button>
            ) : !user ? (
              <Button
                className="w-full gap-2"
                size="lg"
                onClick={() => signInForEntry("subscriber")}
              >
                <KeyRound className="h-4 w-4" aria-hidden />
                Log in to subscribe
              </Button>
            ) : membershipError ? (
              <div className="space-y-2">
                <p className="text-center text-xs text-destructive">
                  We couldn't safely verify your current membership.
                </p>
                <Button
                  className="w-full"
                  size="lg"
                  variant="outline"
                  disabled={busy}
                  onClick={reloadMemberships}
                >
                  Retry membership check
                </Button>
              </div>
            ) : membership ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  {Number(membership.max_price ?? 0) > 0
                    ? `Membership active${formatMembershipExpiry(membership.expires ?? undefined)} and set to renew.`
                    : `Membership active${formatMembershipExpiry(membership.expires ?? undefined)}. Auto-renew is off.`}
                </p>
                <Button
                  className="w-full gap-2"
                  size="lg"
                  variant="secondary"
                  disabled={busy}
                  onClick={confirmMembership}
                >
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <ShieldCheck className="h-4 w-4" aria-hidden />
                  )}
                  Join as a member
                </Button>
              </div>
            ) : !hasMembershipPrice ? (
              <div className="space-y-2">
                <Button className="w-full" size="lg" disabled>
                  Membership unavailable
                </Button>
                <Button asChild variant="outline" className="w-full">
                  <Link to={`/creator/${stream.username}`}>
                    View creator profile
                  </Link>
                </Button>
              </div>
            ) : !membershipAffordable ? (
              <div className="space-y-2">
                <Button className="w-full" size="lg" disabled>
                  Not enough 2Zs
                </Button>
                <Button asChild variant="outline" className="w-full gap-2">
                  <Link to="/wallet/fund">
                    <Coins className="h-4 w-4" aria-hidden />
                    Buy more 2Zs
                  </Link>
                </Button>
                <p className="text-center text-xs text-muted-foreground bidi-number tabular-nums">
                  You have {formatTuzis(tuzis)} · need{" "}
                  {formatTuzis(membershipPrice!)}
                </p>
              </div>
            ) : (
              <Button
                className="w-full gap-2"
                size="lg"
                variant="secondary"
                disabled={busy}
                onClick={() => setMembershipConfirmOpen(true)}
              >
                <Sparkles className="h-4 w-4" aria-hidden />
                Review membership
              </Button>
            )}

            <Dialog
              open={membershipConfirmOpen}
              onOpenChange={(open) => {
                if (!busy) setMembershipConfirmOpen(open);
              }}
            >
              <DialogContent className="max-w-sm">
                <DialogHeader>
                  <DialogTitle>
                    Join {stream.creator.display_name ?? `@${stream.username}`}
                  </DialogTitle>
                  <DialogDescription>
                    This purchase unlocks subscriber posts and livestreams for
                    30 days. New memberships renew automatically, capped at the
                    membership price below; if you previously turned renewal
                    off, this purchase leaves it off. You can manage renewal
                    without losing time already purchased.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3 rounded-lg border border-border bg-background/50 px-4 py-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Monthly price</span>
                    <span className="font-semibold bidi-number tabular-nums">
                      {formatTuzis(membershipPrice ?? 0)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">
                      Current balance
                    </span>
                    <span className="font-medium bidi-number tabular-nums">
                      {formatTuzis(tuzis)}
                    </span>
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Balance after</span>
                    <span className="font-semibold bidi-number tabular-nums">
                      {formatTuzis(Math.max(0, tuzis - (membershipPrice ?? 0)))}
                    </span>
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    variant="ghost"
                    onClick={() => setMembershipConfirmOpen(false)}
                    disabled={busy}
                  >
                    Cancel
                  </Button>
                  <Button
                    className="gap-2"
                    onClick={confirmMembership}
                    disabled={busy || !membershipAffordable}
                  >
                    {busy ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    ) : (
                      <ShieldCheck className="h-4 w-4" aria-hidden />
                    )}
                    Confirm · {formatTuzis(membershipPrice ?? 0)}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        ) : null}

        {/* PPV */}
        {stream.kind === "ppv" ? (
          <>
            <div className="flex items-center justify-between rounded-lg bg-warning/10 px-3 py-2.5">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Coins className="h-4 w-4 text-warning" aria-hidden />
                Entry price
              </span>
              <span className="text-base font-semibold bidi-number tabular-nums text-warning">
                {formatTuzis(price)}
              </span>
            </div>
            {ppvGate === "loading" ? (
              <Button className="w-full gap-2" size="lg" disabled>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Checking account
              </Button>
            ) : ppvGate === "sign-in" ? (
              <Button
                className="w-full gap-2"
                size="lg"
                onClick={() => signInForEntry("ppv")}
              >
                <KeyRound className="h-4 w-4" aria-hidden />
                Sign in to join
              </Button>
            ) : ppvGate === "ready" ? (
              <Button
                className="w-full gap-2"
                size="lg"
                disabled={busy}
                onClick={() => setConfirmOpen(true)}
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Coins className="h-4 w-4" aria-hidden />
                )}
                Join for {formatTuzis(price)}
              </Button>
            ) : (
              <div className="space-y-2">
                <Button className="w-full" size="lg" disabled>
                  Not enough 2Zs
                </Button>
                <Button asChild variant="outline" className="w-full gap-2">
                  <Link to="/wallet/fund">
                    <Coins className="h-4 w-4" aria-hidden />
                    Buy more 2Zs
                  </Link>
                </Button>
                <p className="text-center text-xs text-muted-foreground bidi-number tabular-nums">
                  You have {formatTuzis(tuzis)} · need {formatTuzis(price)}
                </p>
              </div>
            )}

            <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
              <DialogContent className="max-w-sm">
                <DialogHeader>
                  <DialogTitle>Confirm your seat</DialogTitle>
                  <DialogDescription>
                    Spend {formatTuzis(price)} to join{" "}
                    <span className="font-medium text-foreground">
                      {stream.title}
                    </span>
                    .
                  </DialogDescription>
                </DialogHeader>
                <div className="flex items-center justify-between rounded-lg border border-border bg-background/50 px-4 py-3">
                  <span className="text-sm text-muted-foreground">
                    Balance after
                  </span>
                  <span className="text-sm font-semibold bidi-number tabular-nums">
                    {formatTuzis(Math.max(0, tuzis - price))}
                  </span>
                </div>
                <DialogFooter>
                  <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
                    Cancel
                  </Button>
                  <Button className="gap-2" onClick={confirmPpv}>
                    <Coins className="h-4 w-4" aria-hidden />
                    Confirm · {formatTuzis(price)}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        ) : null}

        {/* PRIVATE */}
        {stream.kind === "private" ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!secret.trim() || busy) return;
              void doJoin(undefined, secret);
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="room-secret">Secret phrase</Label>
              <Input
                id="room-secret"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder="Enter the secret to unlock"
                autoComplete="off"
              />
            </div>
            <Button
              type="submit"
              className="w-full gap-2"
              size="lg"
              disabled={busy || !secret.trim()}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <KeyRound className="h-4 w-4" aria-hidden />
              )}
              Enter room
            </Button>
          </form>
        ) : null}

        <p className="text-center text-xs leading-relaxed text-muted-foreground">
          Live video is powered by Cloudflare RealtimeKit — mic, camera, and
          chat all run in the room once you join.
        </p>
      </div>
    </div>
  );
}

function CreatorViewerGuard() {
  return (
    <div className="rounded-xl border border-info/30 bg-info/[0.06] p-4">
      <div className="flex items-center gap-2">
        <Badge variant="sub" className="gap-1.5">
          <ShieldCheck className="h-3 w-3" aria-hidden />
          Creator-safe viewer link
        </Badge>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        This public viewer page will never start, replace, or rotate your active
        room. Open the stream from your Live creator controls instead.
      </p>
      <Button asChild variant="outline" className="mt-4 w-full">
        <Link to="/live">Open Live controls</Link>
      </Button>
    </div>
  );
}

function ViewerIdentityCheck() {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <Button className="w-full gap-2" size="lg" disabled>
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Checking viewer session
      </Button>
      <p className="mt-3 text-center text-xs text-muted-foreground">
        Verifying that this viewer action cannot affect creator controls.
      </p>
    </div>
  );
}

function ConnectedDetails({
  ticket,
  stream,
  onLeave,
}: {
  ticket: DyteJoinTicket;
  stream: Livestream;
  onLeave: () => void;
}) {
  return (
    <div className="rounded-xl border border-success/30 bg-success/[0.06] p-4">
      <div className="flex items-center gap-2">
        <Badge variant="success" className="gap-1.5">
          <ShieldCheck className="h-3 w-3" aria-hidden />
          Connected
        </Badge>
      </div>
      <dl className="mt-3 space-y-2 text-xs">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Meeting ID</dt>
          <dd className="min-w-0">
            <BidiIdentifier
              value={ticket.meetingId}
              shorten
              className="break-all font-mono text-foreground"
            />
          </dd>
        </div>
        {ticket.roomName ? (
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">Room</dt>
            <dd className="min-w-0">
              <BidiIdentifier
                value={ticket.roomName}
                shorten
                className="break-all font-mono text-foreground"
              />
            </dd>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Role</dt>
          <dd className="font-medium capitalize text-foreground">
            {ticket.as}
          </dd>
        </div>
      </dl>
      <Separator className="my-3" />
      <ParticipantStrip count={stream.participants} />
      <Button variant="outline" className="mt-4 w-full gap-2" onClick={onLeave}>
        <LogOut className="rtl:-scale-x-100 h-4 w-4" aria-hidden />
        Leave
      </Button>
    </div>
  );
}

function HostControls({
  stream,
  inviteSecret,
  onEnd,
}: {
  stream: Livestream;
  inviteSecret?: string;
  onEnd: () => void;
}) {
  const inviteInput = useRef<HTMLInputElement>(null);
  const participants = participantCountCopy(stream.participants);
  const inviteUrl =
    inviteSecret && typeof window !== "undefined"
      ? privateInviteDisplayUrl({
          appOrigin: window.location.origin,
          publicWebBase: API_BASE,
          native: isTauri(),
          username: stream.username,
          secret: inviteSecret,
        })
      : null;

  async function copyInvite() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      toast.success("Private invite copied", {
        description: "Share it only with people you want in this room.",
      });
    } catch {
      inviteInput.current?.select();
      toast("Select and copy the private invite shown below.");
    }
  }

  return (
    <div className="rounded-xl border border-primary/30 bg-primary/[0.06] p-4">
      <div className="flex items-center justify-between">
        <Badge variant="live" className="gap-1.5">
          <span
            className="h-1.5 w-1.5 rounded-full bg-live animate-pulse-live"
            aria-hidden
          />
          On air
        </Badge>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Users className="h-3.5 w-3.5" aria-hidden />
          <span className="bidi-number tabular-nums">{participants.watching}</span>
        </span>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        You're hosting as{" "}
        <span className="font-medium text-foreground">@{stream.username}</span>.
        Manage your broadcast below.
      </p>
      <Separator className="my-3" />
      {inviteUrl ? (
        <div className="mb-3 space-y-2">
          <Label htmlFor="private-invite-url">Private invite</Label>
          <Input
            ref={inviteInput}
            id="private-invite-url"
            value={inviteUrl}
            readOnly
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-xs"
          />
          <Button
            variant="secondary"
            className="w-full gap-2"
            onClick={copyInvite}
          >
            <Copy className="h-4 w-4" aria-hidden />
            Copy private invite
          </Button>
          <p className="text-xs text-muted-foreground">
            Anyone with this opaque link can enter while the room is active.
          </p>
        </div>
      ) : null}
      <ParticipantStrip count={stream.participants} />
      <Button
        variant="destructive"
        className="mt-4 w-full gap-2"
        onClick={onEnd}
      >
        <Radio className="h-4 w-4" aria-hidden />
        End stream
      </Button>
    </div>
  );
}

// The real participant roster, active-speaker highlighting, and chat all
// live inside the mounted `<Stage>` (RealtimeKit's own meeting UI) — this
// strip is just lightweight ZUULI chrome around it. Its count stays explicitly
// unavailable until authoritative hydration exists.
function ParticipantStrip({ count }: { count: number | null }) {
  const copy = participantCountCopy(count);
  return (
    <div>
      <div className="mb-2 eyebrow text-muted-foreground">
        In the room
      </div>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Users className="h-3.5 w-3.5" aria-hidden />
        <span className="bidi-number tabular-nums font-medium text-foreground">
          {copy.watching}
        </span>
      </div>
    </div>
  );
}

function RoomSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-5 w-36" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <Skeleton className="aspect-video w-full rounded-2xl" />
          <Skeleton className="h-7 w-3/4" />
          <div className="flex items-center gap-3">
            <Skeleton className="h-10 w-10 rounded-full" />
            <div className="space-y-1.5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
        </div>
        <Skeleton className="h-56 w-full rounded-xl" />
      </div>
    </div>
  );
}
