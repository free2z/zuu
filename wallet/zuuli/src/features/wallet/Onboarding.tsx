import { translate } from "@/i18n/translate";
import { errorKey, localizedError, useMessageError } from "@/i18n/errors";
import { useTranslation as useUiTranslation } from "react-i18next";
import { MESSAGE_KEYS } from "@/i18n/messages";
import { Trans } from "react-i18next";
// Create / restore onboarding, shown when no wallet is initialized.
import { useCallback, useEffect, useRef, useState } from "react";
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
import { isSupportedBip39WordCount } from "@/lib/wallet/mnemonic";
import type { WalletCreated } from "@/lib/wallet/types";
import { useWallet } from "@/store/wallet";
import { cn } from "@/lib/utils";
import {
  SensitiveSeedSession,
  walletSensitiveSeedAuthority,
} from "@/lib/wallet/sensitive-seed";
import { useSensitiveMnemonicEntry } from "@/lib/wallet/sensitive-entry";

export function Onboarding() {
  const { t: uiT } = useUiTranslation();

  const bootstrap = useWallet((s) => s.bootstrap);
  const status = useWallet((s) => s.status);
  const activeWallet = useWallet((s) => s.activeWallet);
  const [created, setCreated] = useState<WalletCreated | null>(null);
  const resumableCreated =
    status?.backupRequired &&
    activeWallet?.id === status.activeWalletId &&
    activeWallet.birthdayHeight !== null
      ? {
          walletId: activeWallet.id,
          birthdayHeight: activeWallet.birthdayHeight,
        }
      : null;
  const backupWallet = created ?? resumableCreated;

  if (backupWallet) {
    return (
      <SeedReveal created={backupWallet} onDone={() => void bootstrap()} />
    );
  }

  // Never offer another create/restore operation over a native wallet that
  // says its backup is pending but lacks a coherent active inventory entry.
  if (status?.backupRequired) {
    return (
      <Card className="mx-auto max-w-lg rounded-xl">
        <CardHeader>
          <CardTitle className="text-base">
            {uiT(MESSAGE_KEYS.featuresWalletOnboardingWalletBackupUnavailable)}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {uiT(
              MESSAGE_KEYS.featuresWalletOnboardingZUULICouldNotVerifyWhichWalletNeeds,
            )}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void bootstrap()}
          >
            {uiT(MESSAGE_KEYS.featuresWalletOnboardingRetryWalletIdentity)}
          </Button>
        </CardContent>
      </Card>
    );
  }

  // Create/restore authority is available only after a coherent native
  // snapshot positively proves that no wallet exists. A missing status is an
  // unknown identity, not an empty one, and an initialized status must never
  // reach setup even if a caller mounts this component directly.
  if (!status || status.initialized) {
    return (
      <Card className="mx-auto max-w-lg rounded-xl">
        <CardHeader>
          <CardTitle className="text-base">
            {uiT(
              MESSAGE_KEYS.featuresWalletOnboardingWalletIdentityUnavailable,
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {uiT(
              MESSAGE_KEYS.featuresWalletOnboardingZUULICouldNotVerifyWhetherAWallet,
            )}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void bootstrap()}
          >
            {uiT(MESSAGE_KEYS.featuresWalletOnboardingRetryWalletIdentity)}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="space-y-2 text-center">
        <h1 className="text-2xl font-bold tracking-tight md:text-3xl">
          {uiT(MESSAGE_KEYS.featuresWalletOnboardingSetUpYourZcashWallet)}
        </h1>
        <p className="text-sm text-muted-foreground">
          {uiT(
            MESSAGE_KEYS.featuresWalletOnboardingCreateABrandNewShieldedWalletOr,
          )}
        </p>
      </div>

      <Tabs defaultValue="create">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="create">
            {uiT(MESSAGE_KEYS.featuresWalletOnboardingCreateNew)}
          </TabsTrigger>
          <TabsTrigger value="restore">
            {uiT(MESSAGE_KEYS.featuresWalletOnboardingRestore)}
          </TabsTrigger>
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

function CreatePane({ onCreated }: { onCreated: (w: WalletCreated) => void }) {
  const { t: uiT } = useUiTranslation();

  const [busy, setBusy] = useState(false);

  const onCreate = useCallback(async () => {
    setBusy(true);
    try {
      const w = await wallet.createWallet();
      onCreated(w);
      await useWallet.getState().refreshWalletIdentity(w.walletId);
    } catch (e) {
      toast.error(
        localizedError(
          e,
          translate(MESSAGE_KEYS.featuresWalletOnboardingCouldnTCreateWallet),
        ),
      );
    } finally {
      setBusy(false);
    }
  }, [onCreated]);

  return (
    <Card className="rounded-xl">
      <CardHeader>
        <CardTitle className="text-base">
          {uiT(MESSAGE_KEYS.featuresWalletOnboardingCreateANewWallet)}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">
          {uiT(MESSAGE_KEYS.featuresWalletOnboardingNewWalletsAlwaysUseA24Word)}
        </p>

        <Button
          type="button"
          variant="zec"
          size="lg"
          className="w-full"
          onClick={onCreate}
          disabled={busy}
        >
          <Trans
            i18nKey={MESSAGE_KEYS.featuresWalletOnboardingCreateWallet}
            components={{
              part1: (
                <>
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <PlusCircle className="h-4 w-4" />
                  )}
                </>
              ),
            }}
          />
        </Button>
      </CardContent>
    </Card>
  );
}

export function RestorePane({ onRestored }: { onRestored: () => void }) {
  const { t: uiT } = useUiTranslation();

  const [seed, setSeed] = useState("");
  const [birthday, setBirthday] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const clearSeed = useCallback(() => {
    setSeed("");
    setReveal(false);
  }, []);
  const sensitiveEntry = useSensitiveMnemonicEntry(
    "zuuliRestore",
    true,
    clearSeed,
  );

  const wordCount = seed.trim() ? seed.trim().split(/\s+/).length : 0;
  const validWordCount = isSupportedBip39WordCount(wordCount);

  const onRestore = useCallback(async () => {
    const phrase = seed.trim().replace(/\s+/g, " ");
    if (!validWordCount) {
      toast.error(
        translate(
          MESSAGE_KEYS.featuresWalletOnboardingARecoveryPhraseMustHave1215,
        ),
      );
      return;
    }
    const height = birthday.trim() ? Number(birthday.trim()) : undefined;
    if (height !== undefined && (!Number.isFinite(height) || height < 0)) {
      toast.error(
        translate(
          MESSAGE_KEYS.featuresWalletOnboardingBirthdayHeightMustBeAPositiveNumber,
        ),
      );
      return;
    }
    setBusy(true);
    try {
      const res = await wallet.restoreWallet(phrase, height);
      if (res.success) {
        void sensitiveEntry.clear();
        await useWallet.getState().refreshWalletIdentity(res.walletId);
        toast.success(
          translate(MESSAGE_KEYS.featuresWalletOnboardingWalletRestored),
        );
        onRestored();
      } else {
        toast.error(
          translate(MESSAGE_KEYS.featuresWalletOnboardingRestoreFailed),
        );
      }
    } catch (e) {
      toast.error(
        localizedError(
          e,
          translate(MESSAGE_KEYS.featuresWalletOnboardingRestoreFailed),
        ),
      );
    } finally {
      setBusy(false);
    }
  }, [seed, birthday, validWordCount, onRestored, sensitiveEntry]);

  return (
    <Card className="rounded-xl">
      <CardHeader>
        <CardTitle className="text-base">
          {uiT(MESSAGE_KEYS.featuresWalletOnboardingRestoreFromSeedPhrase)}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="seed">
              {uiT(MESSAGE_KEYS.featuresWalletOnboardingRecoveryPhrase)}
            </Label>
            <button
              type="button"
              onClick={() => setReveal((r) => !r)}
              disabled={!sensitiveEntry.editable}
              className="min-tap inline-flex items-center gap-1 rounded-md text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-pressed={reveal}
            >
              {reveal ? (
                <>
                  <EyeOff className="h-3.5 w-3.5" />{" "}
                  {uiT(MESSAGE_KEYS.featuresWalletOnboardingHide)}
                </>
              ) : (
                <>
                  <Eye className="h-3.5 w-3.5" />{" "}
                  {uiT(MESSAGE_KEYS.featuresWalletOnboardingShow)}
                </>
              )}
            </button>
          </div>
          <Textarea
            id="seed"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            disabled={!sensitiveEntry.editable || busy}
            placeholder={uiT(
              MESSAGE_KEYS.featuresWalletOnboardingEnterYourRecoveryPhraseSeparatedBySpaces,
            )}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            className={cn(
              "min-h-[104px] resize-none font-mono",
              !reveal &&
                seed &&
                "[-webkit-text-security:disc] [text-security:disc]",
            )}
          />
          {!sensitiveEntry.editable ? (
            <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span>
                {sensitiveEntry.error
                  ? uiT(MESSAGE_KEYS.errorRequest)
                  : uiT(
                      MESSAGE_KEYS.featuresWalletOnboardingSecuringRecoveryPhraseEntry,
                    )}
              </span>
              {sensitiveEntry.error ? (
                <button
                  type="button"
                  className="min-tap rounded-md underline"
                  onClick={() => void sensitiveEntry.retry()}
                >
                  {uiT(MESSAGE_KEYS.featuresWalletOnboardingRetry)}
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              {uiT(
                MESSAGE_KEYS.featuresWalletOnboardingWordsAreNeverSentAnywhereButThe,
              )}
            </span>
            {seed.trim() ? (
              <span
                className={cn(
                  "bidi-number tabular-nums",
                  validWordCount ? "text-success" : "text-muted-foreground",
                )}
              >
                {uiT(MESSAGE_KEYS.wordCount, { count: wordCount })}
              </span>
            ) : null}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="birthday">
            <Trans
              i18nKey={
                MESSAGE_KEYS.featuresWalletOnboardingBirthdayHeightOptional
              }
              components={{
                part1: <span className="text-muted-foreground"></span>,
              }}
            />
          </Label>
          <Input
            id="birthday"
            value={birthday}
            onChange={(e) => setBirthday(e.target.value.replace(/[^\d]/g, ""))}
            inputMode="numeric"
            placeholder={uiT(MESSAGE_KEYS.featuresWalletOnboardingEG2600000)}
            className="bidi-number tabular-nums"
          />
          <p className="text-xs text-muted-foreground">
            {uiT(
              MESSAGE_KEYS.featuresWalletOnboardingTheBlockHeightTheWalletWasCreated,
            )}
          </p>
        </div>

        <Button
          type="button"
          variant="secondary"
          size="lg"
          className="w-full"
          onClick={onRestore}
          disabled={busy || !sensitiveEntry.editable || !validWordCount}
        >
          <Trans
            i18nKey={MESSAGE_KEYS.featuresWalletOnboardingRestoreWallet}
            components={{
              part1: (
                <>
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RotateCcw className="h-4 w-4" />
                  )}
                </>
              ),
            }}
          />
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
  const { t: uiT } = useUiTranslation();

  const [seedPhrase, setSeedPhrase] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useMessageError();
  // React state is not a synchronous exclusion primitive: two clicks in the
  // same render can both observe `busy === false`. Keep the native reveal and
  // acknowledgement ceremonies globally single-flight for this view.
  const operationInFlight = useRef(false);
  const session = useRef<SensitiveSeedSession | null>(null);
  if (!session.current) {
    session.current = new SensitiveSeedSession(
      walletSensitiveSeedAuthority,
      setSeedPhrase,
    );
  }
  const words = seedPhrase?.trim().split(/\s+/) ?? [];

  const hide = useCallback(() => {
    session.current?.clear();
    setConfirmed(false);
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") hide();
    };
    window.addEventListener("blur", hide);
    window.addEventListener("pagehide", hide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", hide);
      window.removeEventListener("pagehide", hide);
      document.removeEventListener("visibilitychange", onVisibility);
      session.current?.clear();
    };
  }, [hide]);

  const reveal = useCallback(async () => {
    if (operationInFlight.current) return;
    operationInFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await session.current!.reveal((token) =>
        wallet.getBackupSeedPhrase(created.walletId, token),
      );
    } catch (cause) {
      setError(
        errorKey(
          cause,
          MESSAGE_KEYS.featuresWalletOnboardingCouldnTRevealRecoveryPhrase,
        ),
      );
    } finally {
      operationInFlight.current = false;
      setBusy(false);
    }
  }, [created.walletId]);

  const finish = useCallback(async () => {
    if (!confirmed || operationInFlight.current) return;
    operationInFlight.current = true;
    hide();
    setBusy(true);
    try {
      await wallet.confirmWalletBackup(created.walletId);
      onDone();
    } catch (cause) {
      setError(
        errorKey(
          cause,
          MESSAGE_KEYS.featuresWalletOnboardingCouldnTSaveBackupConfirmation,
        ),
      );
    } finally {
      operationInFlight.current = false;
      setBusy(false);
    }
  }, [confirmed, created.walletId, hide, onDone]);

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="space-y-2 text-center">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-zec/10 text-zec">
          <ShieldAlert className="h-6 w-6" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight">
          {uiT(MESSAGE_KEYS.featuresWalletOnboardingBackUpYourRecoveryPhrase)}
        </h1>
        <p className="text-sm text-muted-foreground">
          {uiT(
            MESSAGE_KEYS.featuresWalletOnboardingAuthenticateThenWriteTheRecoveryWordsDown,
          )}
        </p>
      </div>

      <Card className="rounded-xl border-zec/40">
        <CardContent className="space-y-4 p-6">
          <div className="flex items-start gap-3 rounded-lg border border-zec/30 bg-zec/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-zec" />
            <p className="text-foreground/90">
              <Trans
                i18nKey={
                  MESSAGE_KEYS.featuresWalletOnboardingThisPhraseIsTheOnlyBackupOf
                }
                components={{ part1: <strong></strong> }}
              />
            </p>
          </div>

          <div className="relative">
            <ol
              className="grid grid-cols-2 gap-2 sm:grid-cols-3"
              aria-hidden="true"
            >
              {words.map((word, i) => (
                <li
                  key={i}
                  className="flex items-center gap-2 rounded-lg border border-border bg-background/50 px-3 py-2"
                >
                  <span className="w-5 shrink-0 text-end text-xs bidi-number tabular-nums text-muted-foreground">
                    {i + 1}
                  </span>
                  <span className="font-mono text-sm">{word}</span>
                </li>
              ))}
            </ol>

            {!seedPhrase ? (
              <button
                type="button"
                onClick={() => void reveal()}
                disabled={busy}
                className="min-h-24 w-full rounded-lg border border-border bg-secondary/40 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex items-center justify-center gap-2">
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                  {busy
                    ? uiT(MESSAGE_KEYS.featuresWalletOnboardingAuthenticating)
                    : uiT(
                        MESSAGE_KEYS.featuresWalletOnboardingAuthenticateToRevealPhrase,
                      )}
                </span>
              </button>
            ) : null}
          </div>

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {uiT(MESSAGE_KEYS.featuresWalletOnboardingBirthdayHeight, {
                value1: formatHeight(created.birthdayHeight),
              })}
            </span>
            {seedPhrase ? (
              <button
                type="button"
                onClick={hide}
                className="min-tap inline-flex items-center gap-1"
              >
                <EyeOff className="h-3.5 w-3.5" />{" "}
                {uiT(MESSAGE_KEYS.featuresWalletOnboardingHidePhrase)}
              </button>
            ) : null}
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <label className="min-h-11 flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              disabled={!seedPhrase || busy}
              className="mt-0.5 h-4 w-4 accent-zec"
            />
            <span>
              {uiT(
                MESSAGE_KEYS.featuresWalletOnboardingIVeWrittenDownMyRecoveryPhrase,
              )}
            </span>
          </label>

          <Button
            type="button"
            variant="zec"
            size="lg"
            className="w-full"
            disabled={!confirmed || busy}
            onClick={() => void finish()}
          >
            {uiT(MESSAGE_KEYS.featuresWalletOnboardingIVeSavedItOpenMyWallet)}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
