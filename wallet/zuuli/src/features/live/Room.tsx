import { useMemo, useState } from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
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
} from "lucide-react";
import { toast } from "sonner";
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
import { live, tuzi } from "@/lib/api/free2z";
import { useAsync } from "@/hooks/useAsync";
import { useSession } from "@/store/session";
import { formatTuzis, timeAgo, initials } from "@/lib/format";
import type { DyteJoinTicket, Livestream, StreamKind } from "@/lib/api/types";
import { KIND_META, gradientFor } from "./lib";
import { Stage } from "./Stage";

interface JustStarted {
  ticket: DyteJoinTicket;
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

  const tuzis = useSession((s) => s.tuzis);
  const adjustTuzis = useSession((s) => s.adjustTuzis);
  const user = useSession((s) => s.user);

  // A host who just went live already has their stream + ticket in navigation
  // state, so we can render the room immediately and skip the public listing
  // fetch entirely — keeping the heavy request off the "Go live" entrance frame
  // so the transition stays smooth. Only a cold visitor (deep link) needs the
  // listing to resolve which stream this is.
  const { data, loading } = useAsync(
    () => (justStarted ? Promise.resolve<Livestream[]>([]) : live.listPublic()),
    [justStarted],
  );

  // Resolve the stream: prefer the public listing; otherwise synthesize one
  // from the just-started host session (creator's own stream isn't public
  // until it's discoverable).
  const stream = useMemo<Livestream | null>(() => {
    const found = (data ?? []).find((s) => s.username === username);
    if (found) return found;
    if (justStarted && (user?.username === username || username === "you")) {
      return {
        id: `local-${username}`,
        username,
        creator: {
          username,
          free2zaddr: username,
          display_name: user?.display_name ?? username,
          image: user?.image ?? null,
        },
        title: justStarted.title,
        kind: justStarted.kind,
        live: true,
        participants: 1,
        price_tuzis: justStarted.price_tuzis,
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

  if (loading && !stream) {
    return <RoomSkeleton />;
  }

  if (!stream) {
    return (
      <div className="space-y-6">
        <BackLink />
        <EmptyState
          icon={Radio}
          title="Stream not found"
          description={`We couldn't find a stream for @${username}. It may have ended.`}
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

  return (
    <div className="space-y-6 animate-slide-up">
      <BackLink />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          {/* Cinematic stage */}
          <div
            className="relative aspect-video w-full overflow-hidden rounded-2xl border border-border shadow-lg"
            style={{ background: gradientFor(seed) }}
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

            <div className="absolute left-4 top-4 flex flex-wrap items-center gap-2">
              {stream.live ? (
                <Badge variant="live" className="gap-1.5 shadow">
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-[#fb7185] animate-pulse-live"
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
              <div className="absolute right-4 top-4 flex items-center gap-1 rounded-full bg-black/55 px-2.5 py-1 text-xs font-medium text-white backdrop-blur">
                <Users className="h-3.5 w-3.5" aria-hidden />
                <span className="tabular-nums">
                  {(stream.participants + (ticket ? 1 : 0)).toLocaleString()}
                </span>{" "}
                watching
              </div>
            ) : null}

            {/* Stage center: either the "off-air" identity or the real meeting */}
            {ticket ? (
              <Stage ticket={ticket} />
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
                <div className="truncate font-medium">{creatorName}</div>
                <div className="truncate text-xs text-muted-foreground">
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
            <JoinPanel
              stream={stream}
              tuzis={tuzis}
              onJoined={(t) => {
                setTicket(t);
                if (stream.kind === "ppv" && stream.price_tuzis > 0) {
                  adjustTuzis(-stream.price_tuzis);
                }
              }}
            />
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
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden />
      All livestreams
    </Link>
  );
}

function JoinPanel({
  stream,
  tuzis,
  onJoined,
}: {
  stream: Livestream;
  tuzis: number;
  onJoined: (ticket: DyteJoinTicket) => void;
}) {
  const kind = KIND_META[stream.kind] ?? KIND_META.broadcast;
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [secret, setSecret] = useState("");

  const price = stream.price_tuzis;
  const affordable = tuzis >= price;

  async function doJoin(
    action?: () => Promise<void>,
    joinSecret?: string,
  ): Promise<boolean> {
    setBusy(true);
    try {
      if (action) await action();
      const ticket = await live.join(stream.username, stream.kind, joinSecret);
      onJoined(ticket);
      return true;
    } catch (e) {
      toast.error("Could not join", {
        description: e instanceof Error ? e.message : "Please try again.",
      });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function confirmPpv() {
    setConfirmOpen(false);
    const ok = await doJoin();
    if (ok) {
      // onJoined has already debited the balance; celebrate the entry.
      toast.success("You're in", {
        description: `Enjoy the stream — ${formatTuzis(price)} spent.`,
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
              This stream is for subscribers. Subscribe to{" "}
              <span className="font-medium text-foreground">
                @{stream.username}
              </span>{" "}
              to watch.
            </p>
            <Button
              className="w-full gap-2"
              size="lg"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                doJoin(async () => {
                  await tuzi.subscribe(stream.username);
                })
              }
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Sparkles className="h-4 w-4" aria-hidden />
              )}
              Subscribe to watch
            </Button>
          </>
        ) : null}

        {/* PPV */}
        {stream.kind === "ppv" ? (
          <>
            <div className="flex items-center justify-between rounded-lg bg-amber-500/10 px-3 py-2.5">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Coins className="h-4 w-4 text-amber-400" aria-hidden />
                Entry price
              </span>
              <span className="text-base font-semibold tabular-nums text-amber-400">
                {formatTuzis(price)}
              </span>
            </div>
            {affordable ? (
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
                  <Link to="/buy">
                    <Coins className="h-4 w-4" aria-hidden />
                    Buy more 2Zs
                  </Link>
                </Button>
                <p className="text-center text-xs text-muted-foreground tabular-nums">
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
                  <span className="text-sm font-semibold tabular-nums">
                    {formatTuzis(Math.max(0, tuzis - price))}
                  </span>
                </div>
                <DialogFooter>
                  <Button
                    variant="ghost"
                    onClick={() => setConfirmOpen(false)}
                  >
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

        <p className="text-center text-[11px] leading-relaxed text-muted-foreground">
          Live video is powered by Cloudflare RealtimeKit — mic, camera, and
          chat all run in the room once you join.
        </p>
      </div>
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
    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.06] p-4">
      <div className="flex items-center gap-2">
        <Badge variant="success" className="gap-1.5">
          <ShieldCheck className="h-3 w-3" aria-hidden />
          Connected
        </Badge>
      </div>
      <dl className="mt-3 space-y-2 text-xs">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Meeting ID</dt>
          <dd className="truncate font-mono text-foreground">
            {ticket.meetingId}
          </dd>
        </div>
        {ticket.roomName ? (
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">Room</dt>
            <dd className="truncate font-mono text-foreground">
              {ticket.roomName}
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
      <ParticipantStrip count={stream.participants + 1} />
      <Button
        variant="outline"
        className="mt-4 w-full gap-2"
        onClick={onLeave}
      >
        <LogOut className="h-4 w-4" aria-hidden />
        Leave
      </Button>
    </div>
  );
}

function HostControls({
  stream,
  onEnd,
}: {
  stream: Livestream;
  onEnd: () => void;
}) {
  return (
    <div className="rounded-xl border border-primary/30 bg-primary/[0.06] p-4">
      <div className="flex items-center justify-between">
        <Badge variant="live" className="gap-1.5">
          <span
            className="h-1.5 w-1.5 rounded-full bg-[#fb7185] animate-pulse-live"
            aria-hidden
          />
          On air
        </Badge>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Users className="h-3.5 w-3.5" aria-hidden />
          <span className="tabular-nums">
            {(stream.participants + 1).toLocaleString()}
          </span>{" "}
          watching
        </span>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        You're hosting as{" "}
        <span className="font-medium text-foreground">@{stream.username}</span>
        . Manage your broadcast below.
      </p>
      <Separator className="my-3" />
      <ParticipantStrip count={stream.participants + 1} />
      <Button variant="destructive" className="mt-4 w-full gap-2" onClick={onEnd}>
        <Radio className="h-4 w-4" aria-hidden />
        End stream
      </Button>
    </div>
  );
}

// The real participant roster, active-speaker highlighting, and chat all
// live inside the mounted `<Stage>` (RealtimeKit's own meeting UI) — this
// strip is just a lightweight, always-real count for the ZUULI chrome
// around it.
function ParticipantStrip({ count }: { count: number }) {
  return (
    <div>
      <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        In the room
      </div>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Users className="h-3.5 w-3.5" aria-hidden />
        <span className="tabular-nums font-medium text-foreground">
          {count.toLocaleString()}
        </span>
        {count === 1 ? "person watching" : "people watching"}
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
