import { useEffect, useState } from "react";
import { Gift, Loader2, Search, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { discover, tuzi } from "@/lib/api/free2z";
import type { SimpleCreator } from "@/lib/api/types";
import { useSession } from "@/store/session";
import { cn } from "@/lib/utils";
import { formatTuzis, formatUsd, initials, tuzisToUsd } from "@/lib/format";
import { MAX_TUZIS, TIP_PRESETS, parseTuzis } from "./lib";

export function SendTab({ onNeedBuy }: { onNeedBuy: () => void }) {
  const tuzis = useSession((s) => s.tuzis);
  const adjustTuzis = useSession((s) => s.adjustTuzis);

  const [creators, setCreators] = useState<SimpleCreator[] | null>(null);
  const [username, setUsername] = useState("");
  const [selected, setSelected] = useState<number>(TIP_PRESETS[1]);
  const [custom, setCustom] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let alive = true;
    discover
      .creators()
      .then((c) => alive && setCreators(c))
      .catch(() => alive && setCreators([]));
    return () => {
      alive = false;
    };
  }, []);

  const amount = custom.trim() ? parseTuzis(custom) : selected;
  const recipient = username.trim();
  const validAmount = amount > 0 && amount <= MAX_TUZIS;
  const enough = amount <= tuzis;
  const canSend = validAmount && recipient.length > 0 && enough && !sending;

  async function send() {
    if (!canSend) return;
    setSending(true);
    try {
      await tuzi.donate(recipient, amount);
      adjustTuzis(-amount);
      toast.success(`Sent ${formatTuzis(amount)} to @${recipient}`, {
        description: "Thanks for supporting the creator.",
      });
      setCustom("");
      setUsername("");
    } catch {
      toast.error("Could not send. Please try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
      <div className="space-y-5">
        {/* Recipient */}
        <div className="space-y-3">
          <Label htmlFor="recipient">Send to</Label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="recipient"
              placeholder="username"
              value={username}
              onChange={(e) =>
                setUsername(e.target.value.replace(/^@/, "").trim())
              }
              className="pl-9"
              aria-label="Recipient username"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            {creators === null
              ? Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-32 rounded-full" />
                ))
              : creators.map((c) => {
                  const active = recipient === c.username;
                  return (
                    <button
                      key={c.username}
                      type="button"
                      onClick={() => setUsername(c.username)}
                      aria-pressed={active}
                      className={cn(
                        "flex items-center gap-2 rounded-full border py-1.5 pl-1.5 pr-3 text-sm transition-colors",
                        active
                          ? "border-primary bg-primary/10"
                          : "border-border hover:border-primary/40 hover:bg-primary/5",
                      )}
                    >
                      <Avatar className="h-7 w-7">
                        {c.image ? (
                          <AvatarImage src={c.image} alt="" />
                        ) : null}
                        <AvatarFallback className="text-[10px]">
                          {initials(c.display_name ?? c.username)}
                        </AvatarFallback>
                      </Avatar>
                      <span className="font-medium">
                        {c.display_name ?? c.username}
                      </span>
                    </button>
                  );
                })}
          </div>
        </div>

        {/* Amount */}
        <div className="space-y-3">
          <Label>Amount</Label>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {TIP_PRESETS.map((preset) => {
              const active = !custom.trim() && selected === preset;
              return (
                <button
                  key={preset}
                  type="button"
                  onClick={() => {
                    setSelected(preset);
                    setCustom("");
                  }}
                  aria-pressed={active}
                  className={cn(
                    "rounded-xl border p-3 text-center transition-all",
                    active
                      ? "border-primary bg-primary/10 shadow-glow"
                      : "border-border hover:border-primary/40 hover:bg-primary/5",
                  )}
                >
                  <div className="text-base font-bold tabular-nums">
                    {preset.toLocaleString()}
                  </div>
                  <div className="text-[10px] font-medium text-primary">2Z</div>
                </button>
              );
            })}
          </div>
          <div className="relative">
            <Input
              inputMode="numeric"
              placeholder="Custom amount"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              className="pr-24 tabular-nums"
              aria-label="Custom tip amount in 2Z"
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium tabular-nums text-muted-foreground">
              {custom.trim() && parseTuzis(custom) > 0
                ? formatUsd(tuzisToUsd(parseTuzis(custom)))
                : "2Z"}
            </span>
          </div>
        </div>
      </div>

      {/* Summary */}
      <Card className="h-fit lg:sticky lg:top-4">
        <CardHeader className="pb-4">
          <CardTitle>Review tip</CardTitle>
          <CardDescription>Sent instantly from your 2Z balance.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Recipient</span>
            <span className="font-medium">
              {recipient ? `@${recipient}` : "—"}
            </span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-muted-foreground">Amount</span>
            <div className="text-right">
              <div className="text-xl font-bold tabular-nums">
                {validAmount ? formatTuzis(amount) : "—"}
              </div>
              {validAmount && (
                <div className="text-xs tabular-nums text-muted-foreground">
                  {formatUsd(tuzisToUsd(amount))}
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center justify-between border-t border-border pt-3 text-sm">
            <span className="text-muted-foreground">Balance after</span>
            <span
              className={cn(
                "tabular-nums",
                validAmount && !enough && "text-destructive",
              )}
            >
              {formatTuzis(Math.max(0, tuzis - (validAmount ? amount : 0)))}
            </span>
          </div>

          {validAmount && !enough ? (
            <Button
              variant="outline"
              className="w-full"
              onClick={onNeedBuy}
            >
              Not enough 2Z — buy more
              <ArrowRight className="h-4 w-4" />
            </Button>
          ) : (
            <Button className="w-full" disabled={!canSend} onClick={send}>
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Gift className="h-4 w-4" />
              )}
              Send 2Zs
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
