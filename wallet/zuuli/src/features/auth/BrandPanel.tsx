import { useTranslation as useUiTranslation } from "react-i18next";
import { translate } from "@/i18n/translate";
import { MESSAGE_KEYS } from "@/i18n/messages";
// Left-hand cinematic brand panel — the pitch for keys-as-identity. Hidden on
// small screens where the action panel takes the full viewport.

import { EyeOff, Fingerprint, KeyRound, ShieldCheck } from "lucide-react";
import { Wordmark } from "@/components/brand/Logo";
import { APP_TAGLINE, COMPANY } from "@/lib/env";

const VALUES = [
  {
    icon: Fingerprint,
    get title() {
      return translate(
        MESSAGE_KEYS.featuresAuthBrandPanelYourKeyIsYourIdentity,
      );
    },
    get body() {
      return translate(
        MESSAGE_KEYS.featuresAuthBrandPanelOneZcashKeySignsYouInEverywhere,
      );
    },
  },
  {
    icon: EyeOff,
    get title() {
      return translate(
        MESSAGE_KEYS.featuresAuthBrandPanelNoEmailNoPasswordNoKYC,
      );
    },
    get body() {
      return translate(
        MESSAGE_KEYS.featuresAuthBrandPanelNothingToPhishLeakOrResetThere,
      );
    },
  },
  {
    icon: KeyRound,
    get title() {
      return translate(
        MESSAGE_KEYS.featuresAuthBrandPanelW3CDIDZIP304Signatures,
      );
    },
    get body() {
      return translate(
        MESSAGE_KEYS.featuresAuthBrandPanelOpenStandardsNotAProprietaryLoginYour,
      );
    },
  },
  {
    icon: ShieldCheck,
    get title() {
      return translate(MESSAGE_KEYS.featuresAuthBrandPanelAnonymousByDesign);
    },
    get body() {
      return translate(
        MESSAGE_KEYS.featuresAuthBrandPanelProveControlWithoutRevealingWhoYouAre,
      );
    },
  },
] as const;

export function BrandPanel() {
  const { t: uiT } = useUiTranslation();

  return (
    <aside className="relative hidden flex-col justify-between border-e border-border bg-background p-10 lg:flex xl:p-14">
      <Wordmark />

      <div className="relative max-w-md space-y-10">
        <div className="space-y-3">
          <h1 className="text-balance text-4xl font-semibold leading-[1.1] xl:text-5xl">
            {uiT(
              MESSAGE_KEYS.featuresAuthBrandPanelLogInYourWayIncludingWithJust,
            )}
          </h1>
          <p className="text-lg text-muted-foreground">{APP_TAGLINE}</p>
        </div>

        <div className="space-y-4">
          <p className="eyebrow text-muted-foreground">
            {uiT(MESSAGE_KEYS.featuresAuthBrandPanelWhyZcash)}
          </p>
          <ul className="space-y-5">
            {VALUES.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex gap-3.5">
                <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-secondary text-muted-foreground">
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                <div className="space-y-0.5">
                  <p className="font-semibold">{title}</p>
                  <p className="text-sm text-muted-foreground">{body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <p className="relative text-xs text-muted-foreground">
        © {new Date().getFullYear()} {COMPANY}
      </p>
    </aside>
  );
}
