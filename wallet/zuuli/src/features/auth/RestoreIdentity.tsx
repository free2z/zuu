import { useMessageError } from "@/i18n/errors";
import { useTranslation as useUiTranslation } from "react-i18next";
import { MESSAGE_KEYS } from "@/i18n/messages";
import { Trans } from "react-i18next";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { ArrowLeft, Eye, EyeOff, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { isSupportedBip39WordCount } from "@/lib/wallet/mnemonic";

interface RestoreIdentityProps {
  restoring: boolean;
  error: string | null;
  onCancel: () => void;
  onRestore: (
    seedPhrase: string,
    birthdayHeight: number | undefined,
    clearPhrase: () => void,
  ) => Promise<void>;
}

export function RestoreIdentity({
  restoring,
  error,
  onCancel,
  onRestore,
}: RestoreIdentityProps) {
  const { t: uiT } = useUiTranslation();

  const recoveryId = useId();
  const birthdayId = useId();
  const phraseRef = useRef("");
  const [seedPhrase, setSeedPhrase] = useState("");
  const [birthday, setBirthday] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [localError, setLocalError] = useMessageError();
  const normalizedPhrase = useMemo(
    () => seedPhrase.trim().replace(/\s+/g, " "),
    [seedPhrase],
  );
  const wordCount = normalizedPhrase ? normalizedPhrase.split(" ").length : 0;
  const supportedWordCount = isSupportedBip39WordCount(wordCount);

  useEffect(() => {
    return () => {
      // The phrase is renderer-only and must not survive a method switch,
      // close, route change, or completed restore.
      phraseRef.current = "";
    };
  }, []);

  const clearPhrase = () => {
    phraseRef.current = "";
    setSeedPhrase("");
    setRevealed(false);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setLocalError(null);
    if (!normalizedPhrase) {
      setLocalError(
        MESSAGE_KEYS.featuresAuthRestoreIdentityEnterYourRecoveryPhrase,
      );
      return;
    }
    if (!supportedWordCount) {
      setLocalError(
        MESSAGE_KEYS.featuresAuthRestoreIdentityARecoveryPhraseMustHave1215,
      );
      return;
    }

    const birthdayHeight = birthday ? Number(birthday) : undefined;
    if (
      birthdayHeight !== undefined &&
      (!Number.isSafeInteger(birthdayHeight) || birthdayHeight < 0)
    ) {
      setLocalError(
        MESSAGE_KEYS.featuresAuthRestoreIdentityEnterAValidBirthdayHeight,
      );
      return;
    }

    // Do not keep an async form-frame alive with another reference to the
    // phrase. The flow owns the native promise and reports status through its
    // phase/error state.
    void onRestore(normalizedPhrase, birthdayHeight, clearPhrase);
  };

  return (
    <form
      className="animate-slide-up space-y-4"
      data-auth-restore
      onSubmit={submit}
    >
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="min-tap h-11 w-11 shrink-0"
          onClick={() => {
            clearPhrase();
            onCancel();
          }}
          disabled={restoring}
          aria-label={uiT(
            MESSAGE_KEYS.featuresAuthRestoreIdentityBackToIdentityChoices,
          )}
        >
          <ArrowLeft className="rtl:-scale-x-100" aria-hidden />
        </Button>
        <div className="min-w-0">
          <h2 className="font-semibold">
            {uiT(MESSAGE_KEYS.featuresAuthRestoreIdentityUseExistingIdentity)}
          </h2>
          <p className="text-xs text-muted-foreground">
            {uiT(
              MESSAGE_KEYS.featuresAuthRestoreIdentityRestoreLocallyWithYourRecoveryPhrase,
            )}
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={recoveryId}>
            {uiT(MESSAGE_KEYS.featuresAuthRestoreIdentityRecoveryPhrase)}
          </Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-tap shrink-0 text-muted-foreground"
            onClick={() => setRevealed((value) => !value)}
            disabled={restoring || !seedPhrase}
            aria-pressed={revealed}
          >
            {revealed ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
            {revealed
              ? uiT(MESSAGE_KEYS.featuresAuthRestoreIdentityHide)
              : uiT(MESSAGE_KEYS.featuresAuthRestoreIdentityShow)}
          </Button>
        </div>
        <Textarea
          id={recoveryId}
          value={seedPhrase}
          onChange={(event) => {
            phraseRef.current = event.target.value;
            setSeedPhrase(event.target.value);
          }}
          placeholder={uiT(
            MESSAGE_KEYS.featuresAuthRestoreIdentityWordsSeparatedBySpaces,
          )}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          disabled={restoring}
          aria-describedby={`${recoveryId}-hint`}
          className={cn(
            "min-h-20 resize-none font-mono",
            !revealed &&
              seedPhrase &&
              "[-webkit-text-security:disc] [text-security:disc]",
          )}
        />
        <div
          id={`${recoveryId}-hint`}
          className="flex min-w-0 items-start justify-between gap-3 text-xs text-muted-foreground"
        >
          <span className="min-w-0">
            {uiT(MESSAGE_KEYS.featuresAuthRestoreIdentityNeverSentToFree2z)}
          </span>
          <span
            className={cn(
              "shrink-0 bidi-number tabular-nums",
              wordCount && supportedWordCount && "text-success",
            )}
          >
            {uiT(MESSAGE_KEYS.wordCount, { count: wordCount })}
          </span>
        </div>
        {wordCount > 0 && !supportedWordCount && (
          <p className="text-xs text-warning">
            {uiT(
              MESSAGE_KEYS.featuresAuthRestoreIdentitySupportedPhrasesUsuallyHave121518,
            )}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={birthdayId}>
          <Trans
            i18nKey={
              MESSAGE_KEYS.featuresAuthRestoreIdentityBirthdayHeightOptional
            }
            components={{
              part1: <span className="text-muted-foreground"></span>,
            }}
          />
        </Label>
        <Input
          id={birthdayId}
          value={birthday}
          onChange={(event) =>
            setBirthday(event.target.value.replace(/[^\d]/g, ""))
          }
          inputMode="numeric"
          placeholder={uiT(
            MESSAGE_KEYS.featuresAuthRestoreIdentityFasterWalletScan,
          )}
          className="min-tap bidi-number tabular-nums"
          disabled={restoring}
        />
      </div>

      {(localError || error) && (
        <p role="alert" className="text-sm text-destructive">
          {localError ?? error}
        </p>
      )}

      <Button
        type="submit"
        size="lg"
        className="w-full"
        disabled={restoring || !supportedWordCount}
      >
        {restoring ? (
          <Loader2 className="animate-spin" aria-hidden />
        ) : (
          <RotateCcw aria-hidden />
        )}
        {restoring
          ? uiT(MESSAGE_KEYS.featuresAuthRestoreIdentityRestoringIdentity)
          : uiT(MESSAGE_KEYS.featuresAuthRestoreIdentityRestoreAndContinue)}
      </Button>

      <p className="text-center text-xs text-muted-foreground">
        {uiT(
          MESSAGE_KEYS.featuresAuthRestoreIdentityExternalWalletSigningIsnTSupportedYet,
        )}
      </p>
    </form>
  );
}
