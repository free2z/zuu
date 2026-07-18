import { useState } from "react";
import { Heart, Loader2 } from "lucide-react";
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
import { formatTuzis } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { SimpleCreator } from "@/lib/api/types";

const PRESETS = [50, 100, 250, 500];

export function TipDialog({ author }: { author: SimpleCreator }) {
  const name = author.display_name || author.username;
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(100);
  const [sending, setSending] = useState(false);

  async function send() {
    if (amount <= 0) {
      toast.error("Enter an amount greater than zero.");
      return;
    }
    setSending(true);
    try {
      await tuzi.donate(author.username, amount);
      toast.success(`Sent ${formatTuzis(amount)} to ${name}`);
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
            Send 2Zs straight to the author. 1 2Z = 1 cent.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-4 gap-2">
            {PRESETS.map((preset) => (
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
            <Label htmlFor="tip-amount">Amount (2Z)</Label>
            <Input
              id="tip-amount"
              type="number"
              min={1}
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(Math.max(0, Number(e.target.value)))}
              className="tabular-nums"
            />
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
          <Button onClick={send} disabled={sending}>
            {sending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Sending
              </>
            ) : (
              <>Send {formatTuzis(amount)}</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
