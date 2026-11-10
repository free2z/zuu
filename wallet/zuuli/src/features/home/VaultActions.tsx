import { useTranslation as useUiTranslation } from "react-i18next";
import { translate } from "@/i18n/translate";
import { MESSAGE_KEYS } from "@/i18n/messages";
import { Link } from "react-router-dom";
import {
  ArrowUpRight,
  Coins,
  History,
  QrCode,
  Send,
  type LucideIcon,
} from "lucide-react";
import { SectionHeader } from "./parts";

interface VaultAction {
  to: string;
  icon: LucideIcon;
  title: string;
  description: string;
}

/**
 * Every destination here is inside this app's own wallet. Nothing on this
 * screen loads a remote document, a remote image, or a third-party SDK.
 */
const ACTIONS: readonly VaultAction[] = [
  {
    to: "/wallet/send",
    icon: Send,
    get title() {
      return translate(MESSAGE_KEYS.featuresHomeVaultActionsSend);
    },
    get description() {
      return translate(
        MESSAGE_KEYS.featuresHomeVaultActionsShieldedZECWithAnOptionalEncryptedMemo,
      );
    },
  },
  {
    to: "/wallet/receive",
    icon: QrCode,
    get title() {
      return translate(MESSAGE_KEYS.featuresHomeVaultActionsReceive);
    },
    get description() {
      return translate(
        MESSAGE_KEYS.featuresHomeVaultActionsShareYourUnifiedAddressToGetPaid,
      );
    },
  },
  {
    to: "/wallet/history",
    icon: History,
    get title() {
      return translate(MESSAGE_KEYS.featuresHomeVaultActionsHistory);
    },
    get description() {
      return translate(
        MESSAGE_KEYS.featuresHomeVaultActionsEveryPaymentInAndOutOfThis,
      );
    },
  },
  {
    to: "/wallet/fund",
    icon: Coins,
    get title() {
      return translate(MESSAGE_KEYS.featuresHomeVaultActionsFund);
    },
    get description() {
      return translate(
        MESSAGE_KEYS.featuresHomeVaultActionsAdd2ZsWithACardOrTop,
      );
    },
  },
];

export function VaultActions() {
  const { t: uiT } = useUiTranslation();

  return (
    <div>
      <SectionHeader
        icon={Send}
        title={uiT(MESSAGE_KEYS.featuresHomeVaultActionsYourWallet)}
        subtitle={uiT(MESSAGE_KEYS.homeWalletScope)}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        {ACTIONS.map((action) => (
          <Link
            key={action.to}
            to={action.to}
            className="group flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-4 transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <span
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-secondary text-primary"
              aria-hidden
            >
              <action.icon className="h-[18px] w-[18px]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-medium leading-tight">
                {action.title}
              </span>
              <span className="mt-1 block text-sm text-muted-foreground">
                {action.description}
              </span>
            </span>
            <ArrowUpRight
              className="rtl:-scale-x-100 ms-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:-translate-y-0.5 ltr:group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5"
              aria-hidden
            />
          </Link>
        ))}
      </div>
    </div>
  );
}
