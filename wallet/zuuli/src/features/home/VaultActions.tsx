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
    title: "Send",
    description: "Shielded ZEC with an optional encrypted memo.",
  },
  {
    to: "/wallet/receive",
    icon: QrCode,
    title: "Receive",
    description: "Share your unified address to get paid privately.",
  },
  {
    to: "/wallet/history",
    icon: History,
    title: "History",
    description: "Every payment in and out of this wallet.",
  },
  {
    to: "/wallet/fund",
    icon: Coins,
    title: "Fund",
    description: "Add 2Zs with a card, or top up from ZEC.",
  },
];

export function VaultActions() {
  return (
    <div>
      <SectionHeader
        icon={Send}
        title="Your wallet"
        subtitle="Keys, spending and history stay in this app and nowhere else."
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
