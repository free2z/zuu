import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Heart, Loader2 } from "lucide-react";
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
import { tuzi } from "@/lib/api/free2z";
import {
  formatTuzis,
  MAX_TUZIS,
  tuziInputMaxLength,
  validateTuzis,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { useSession } from "@/store/session";
import type { SimpleCreator } from "@/lib/api/types";

const PRESETS = [50, 100, 250, 500];

export function TipDialog({ author }: { author: SimpleCreator }) {
  const name = author.display_name || author.username;
  const navigate = useNavigate();
  const tuzis = useSession((s) => s.tuzis);
  const adjustTuzis = useSession((s) => s.adjustTuzis);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("100");
  const [sending, setSending] = useState(false);

  const amountResult = validateTuzis(amount, { minimum: 1, maximum: MAX_TUZIS });
  const parsedAmount = amountResult.value;
  const validAmount = amountResult.error === null;
  const enough = parsedAmount !== null && parsedAmount <= tuzis;
  const canSend = validAmount && enough && !sending;

  async function send() {
    if (!canSend || parsedAmount === null) return;
    setSending(true);
    try {
      await tuzi.donate(author.username, parsedAmount);
      adjustTuzis(-parsedAmount);
      toast.success(`Sent ${formatTuzis(parsedAmount)} to ${name}`);
      setOpen(false);
    } catch {
      toast.error("Could not send your tip. Please try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="default" aria-label={`Tip ${name}`}>
          <Heart className="h-4 w-4" aria-hidden />
          Tip the author
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tip {name}</DialogTitle>
          <DialogDescription>
            Send 2Zs straight to the author, from your platform credit balance.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-4 gap-2">
            {PRESETS.map((preset) => (
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
            <Label htmlFor="tip-amount">Amount (2Z)</Label>
            <Input
              id="tip-amount"
              type="text"
              inputMode="numeric"
              maxLength={tuziInputMaxLength(MAX_TUZIS)}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="tabular-nums"
              aria-describedby="tip-amount-error tip-balance"
              aria-invalid={amount.length > 0 && !validAmount}
            />
            <p id="tip-balance" className="text-xs text-muted-foreground tabular-nums">
              Balance: {formatTuzis(tuzis)}
            </p>
            <p id="tip-amount-error" className="min-h-[1rem] text-xs text-destructive">
              {amountResult.error === "tooLarge"
                ? `Max ${MAX_TUZIS.toLocaleString()} 2Z per tip.`
                : amount.length > 0 && amountResult.error !== null
                  ? "Enter a positive whole 2Z amount; commas may separate thousands."
                  : null}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={sending}
          >
            Cancel
          </Button>
          {validAmount && !enough ? (
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
              {sending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  Sending
                </>
              ) : (
                <>Send {parsedAmount !== null ? formatTuzis(parsedAmount) : "2Zs"}</>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
