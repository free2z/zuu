// Create / restore onboarding, shown when no wallet is initialized.
import { useCallback, useState } from "react";
import {
  AlertTriangle,
  Eye,
  EyeOff,
  Loader2,
  PlusCircle,
  RotateCcw,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatHeight } from "@/lib/format";
import { wallet } from "@/lib/wallet/bridge";
import type { WalletCreated } from "@/lib/wallet/types";
import { useWallet } from "@/store/wallet";
import { cn } from "@/lib/utils";
import { CopyButton } from "./shared";

export function Onboarding() {
  const bootstrap = useWallet((s) => s.bootstrap);
  const [created, setCreated] = useState<WalletCreated | null>(null);

  if (created) {
    return <SeedReveal created={created} onDone={() => void bootstrap()} />;
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="space-y-2 text-center">
        <h1 className="text-2xl font-bold tracking-tight md:text-3xl">
          Set up your Zcash wallet
        </h1>
        <p className="text-sm text-muted-foreground">
          Create a brand-new shielded wallet, or restore one from a seed phrase.
          Your keys never leave this device.
        </p>
      </div>

      <Tabs defaultValue="create">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="create">Create new</TabsTrigger>
          <TabsTrigger value="restore">Restore</TabsTrigger>
        </TabsList>

        <TabsContent value="create">
          <CreatePane onCreated={setCreated} />
        </TabsContent>
        <TabsContent value="restore">
          <RestorePane onRestored={() => void bootstrap()} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function CreatePane({
  onCreated,
}: {
  onCreated: (w: WalletCreated) => void;
}) {
  const [wordCount, setWordCount] = useState<12 | 24>(24);
  const [busy, setBusy] = useState(false);

  const onCreate = useCallback(async () => {
    setBusy(true);
    try {
      const w = await wallet.createWallet(wordCount);
      onCreated(w);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't create wallet");
    } finally {
      setBusy(false);
    }
  }, [wordCount, onCreated]);

  return (
    <Card className="rounded-xl">
      <CardHeader>
        <CardTitle className="text-base">Create a new wallet</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <Label>Recovery phrase length</Label>
          <div className="grid grid-cols-2 gap-2">
            {([12, 24] as const).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setWordCount(n)}
                className={cn(
                  "rounded-lg border px-4 py-3 text-sm font-medium transition-colors",
                  wordCount === n
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:bg-secondary",
                )}
                aria-pressed={wordCount === n}
              >
                {n} words
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            24 words is the recommended default for maximum security.
          </p>
        </div>

        <Button
          type="button"
          variant="zec"
          size="lg"
          className="w-full"
          onClick={onCreate}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <PlusCircle className="h-4 w-4" />
          )}
          Create wallet
        </Button>
      </CardContent>
    </Card>
  );
}

function RestorePane({ onRestored }: { onRestored: () => void }) {
  const [seed, setSeed] = useState("");
  const [birthday, setBirthday] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);

  const wordCount = seed.trim() ? seed.trim().split(/\s+/).length : 0;
  const validWordCount = wordCount === 12 || wordCount === 24;

  const onRestore = useCallback(async () => {
    const phrase = seed.trim().replace(/\s+/g, " ");
    if (!validWordCount) {
      toast.error("A seed phrase must be 12 or 24 words");
      return;
    }
    const height = birthday.trim() ? Number(birthday.trim()) : undefined;
    if (height !== undefined && (!Number.isFinite(height) || height < 0)) {
      toast.error("Birthday height must be a positive number");
      return;
    }
    setBusy(true);
    try {
      const res = await wallet.restoreWallet(phrase, height);
      if (res.success) {
        toast.success("Wallet restored");
        onRestored();
      } else {
        toast.error("Restore failed");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Restore failed");
    } finally {
      setBusy(false);
    }
  }, [seed, birthday, validWordCount, onRestored]);

  return (
    <Card className="rounded-xl">
      <CardHeader>
        <CardTitle className="text-base">Restore from seed phrase</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="seed">Recovery phrase</Label>
            <button
              type="button"
              onClick={() => setReveal((r) => !r)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              aria-pressed={reveal}
            >
              {reveal ? (
                <>
                  <EyeOff className="h-3.5 w-3.5" /> Hide
                </>
              ) : (
                <>
                  <Eye className="h-3.5 w-3.5" /> Show
                </>
              )}
            </button>
          </div>
          <Textarea
            id="seed"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            placeholder="Enter your 12 or 24 word recovery phrase, separated by spaces"
            spellCheck={false}
            autoComplete="off"
            className={cn(
              "min-h-[104px] resize-none font-mono",
              !reveal && seed && "[-webkit-text-security:disc] [text-security:disc]",
            )}
          />
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              Words are never sent anywhere but the local wallet engine.
            </span>
            {seed.trim() ? (
              <span
                className={cn(
                  "tabular-nums",
                  validWordCount ? "text-emerald-400" : "text-muted-foreground",
                )}
              >
                {wordCount} words
              </span>
            ) : null}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="birthday">
            Birthday height{" "}
            <span className="text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="birthday"
            value={birthday}
            onChange={(e) => setBirthday(e.target.value.replace(/[^\d]/g, ""))}
            inputMode="numeric"
            placeholder="e.g. 2600000"
            className="tabular-nums"
          />
          <p className="text-xs text-muted-foreground">
            The block height the wallet was created at. Speeds up the initial
            scan — leave blank to scan from the sapling activation.
          </p>
        </div>

        <Button
          type="button"
          variant="secondary"
          size="lg"
          className="w-full"
          onClick={onRestore}
          disabled={busy || !validWordCount}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RotateCcw className="h-4 w-4" />
          )}
          Restore wallet
        </Button>
      </CardContent>
    </Card>
  );
}

function SeedReveal({
  created,
  onDone,
}: {
  created: WalletCreated;
  onDone: () => void;
}) {
  const [reveal, setReveal] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const words = created.seedPhrase.trim().split(/\s+/);

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="space-y-2 text-center">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-[#f4b728]/15 text-[#f4b728]">
          <ShieldAlert className="h-6 w-6" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight">
          Back up your recovery phrase
        </h1>
        <p className="text-sm text-muted-foreground">
          Write these {words.length} words down in order and store them offline.
        </p>
      </div>

      <Card className="rounded-xl border-[#f4b728]/40">
        <CardContent className="space-y-4 p-6">
          <div className="flex items-start gap-3 rounded-lg border border-[#f4b728]/30 bg-[#f4b728]/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#f4b728]" />
            <p className="text-foreground/90">
              This phrase is the <strong>only</strong> backup of your funds.
              Anyone who sees it can take your ZEC. ZUULI can never recover it
              for you.
            </p>
          </div>

          <div className="relative">
            <ol
              className={cn(
                "grid grid-cols-2 gap-2 sm:grid-cols-3",
                !reveal && "select-none blur-md",
              )}
              aria-hidden={!reveal}
            >
              {words.map((word, i) => (
                <li
                  key={i}
                  className="flex items-center gap-2 rounded-lg border border-border bg-background/50 px-3 py-2"
                >
                  <span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                    {i + 1}
                  </span>
                  <span className="font-mono text-sm">{word}</span>
                </li>
              ))}
            </ol>

            {!reveal ? (
              <button
                type="button"
                onClick={() => setReveal(true)}
                className="absolute inset-0 grid place-items-center rounded-lg bg-background/20 text-sm font-medium backdrop-blur-[2px]"
              >
                <span className="flex items-center gap-2 rounded-full bg-secondary px-4 py-2 shadow">
                  <Eye className="h-4 w-4" />
                  Tap to reveal phrase
                </span>
              </button>
            ) : null}
          </div>

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Birthday height {formatHeight(created.birthdayHeight)}</span>
            {reveal ? (
              <CopyButton
                value={created.seedPhrase}
                size="sm"
                label="Recovery phrase copied"
                ariaLabel="Copy recovery phrase"
              />
            ) : null}
          </div>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              disabled={!reveal}
              className="mt-0.5 h-4 w-4 accent-[#f4b728]"
            />
            <span>
              I've written down my recovery phrase and stored it somewhere safe.
            </span>
          </label>

          <Button
            type="button"
            variant="zec"
            size="lg"
            className="w-full"
            disabled={!confirmed}
            onClick={onDone}
          >
            I've saved it — open my wallet
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
