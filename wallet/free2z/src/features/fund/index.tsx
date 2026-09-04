import { useTranslation } from "react-i18next";
import { Coins } from "lucide-react";
import { PageHeader } from "@/components/common/PageHeader";
import { Callout } from "@/components/ui/callout";
import { MESSAGE_KEYS } from "@/i18n/messages";

/**
 * The 2Z top-up destination, pending the funding move.
 *
 * `wallet/zuuli/src/features/wallet/funding/` is described as HTTP + Stripe
 * only, and its card checkout is — but `index.tsx`, `BalanceHero`, `SendTab`
 * and `zec-top-up-demo` all read `store/wallet`, the one thing this surface's
 * shell must never do (#904). Severing that ZEC top-up path from the card
 * checkout is its own reviewable change, so this route states where 2Z top-up
 * lives today instead of shipping a link that dead-ends.
 */
export default function FundFeature() {
  const { t } = useTranslation();
  return (
    <section className="animate-slide-up pb-16">
      <PageHeader title={t(MESSAGE_KEYS.fundTitle)} />
      <Callout tone="info" icon={Coins} data-fund-pending>
        {t(MESSAGE_KEYS.fundBody)}
      </Callout>
    </section>
  );
}
