import { useTranslation as useUiTranslation } from "react-i18next";
import { translate } from "@/i18n/translate";
import { MESSAGE_KEYS } from "@/i18n/messages";
// "How does this work?" — a plain-language explainer of the ZShield concept:
// any Zcash address is a self-sovereign W3C DID, and you prove control by
// signing a challenge (ZIP-304). No third party, no password, no email.

import { Fingerprint, KeyRound, ShieldCheck } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const POINTS = [
  {
    icon: Fingerprint,
    get title() {
      return translate(MESSAGE_KEYS.featuresAuthZShieldInfoYourAddressIsADID);
    },
    get body() {
      return translate(
        MESSAGE_KEYS.featuresAuthZShieldInfoAnyZcashAddressMapsToAW3C,
      );
    },
  },
  {
    icon: KeyRound,
    get title() {
      return translate(
        MESSAGE_KEYS.featuresAuthZShieldInfoYouProveControlBySigning,
      );
    },
    get body() {
      return translate(
        MESSAGE_KEYS.featuresAuthZShieldInfoToLogInYouSignAFresh,
      );
    },
  },
  {
    icon: ShieldCheck,
    get title() {
      return translate(
        MESSAGE_KEYS.featuresAuthZShieldInfoNoThirdPartyInTheLoop,
      );
    },
    get body() {
      return translate(
        MESSAGE_KEYS.featuresAuthZShieldInfoFree2zVerifiesTheSignatureAgainstYourAddress,
      );
    },
  },
] as const;

export function ZShieldInfo({ children }: { children: React.ReactNode }) {
  const { t: uiT } = useUiTranslation();

  return (
    <Dialog>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" aria-hidden />
            {uiT(
              MESSAGE_KEYS.featuresAuthZShieldInfoZShieldYourKeyIsYourIdentity,
            )}
          </DialogTitle>
          <DialogDescription>
            {uiT(
              MESSAGE_KEYS.featuresAuthZShieldInfoLoginWithZcashReplacesPasswordsAndEmail,
            )}
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-4">
          {POINTS.map(({ icon: Icon, title, body }) => (
            <li key={title} className="flex gap-3">
              <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-secondary text-muted-foreground">
                <Icon className="h-5 w-5" aria-hidden />
              </span>
              <div className="space-y-0.5">
                <p className="text-sm font-semibold">{title}</p>
                <p className="text-sm text-muted-foreground">{body}</p>
              </div>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
