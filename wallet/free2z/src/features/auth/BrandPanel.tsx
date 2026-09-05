// Left-hand brand panel — the pitch for the content surface. Hidden on small
// screens where the action panel takes the full viewport.
//
// ZUULI's panel argues for keys-as-identity, because ZUULI is where the key
// lives. This one argues for the separation itself: the reason a reader is
// looking at a second app at all.

import { BookOpen, Coins, KeyRound, ShieldOff } from "lucide-react";
import { Wordmark } from "@/components/brand/Logo";
import { COMPANY } from "@/lib/env";

const VALUES = [
  {
    icon: BookOpen,
    title: "Articles, unabridged",
    body: "Embeds, diagrams, math and remote media render here — because nothing in this app can spend.",
  },
  {
    icon: ShieldOff,
    title: "No seed, no spending key",
    body: "This app links no Zcash plugin and holds no privileged capability. There is nothing here for a page to reach.",
  },
  {
    icon: Coins,
    title: "2Zs, not ZEC",
    body: "Tips and paid actions here spend 2Z content credits. A Zcash transaction is always signed in ZUULI.",
  },
  {
    icon: KeyRound,
    title: "One identity, two surfaces",
    body: "The same free2z account signs you in. Which app holds your key stays your decision.",
  },
] as const;

export function BrandPanel() {
  return (
    <aside className="relative hidden flex-col justify-between border-e border-border bg-background p-10 lg:flex xl:p-14">
      <Wordmark />

      <div className="relative max-w-md space-y-10">
        <div className="space-y-3">
          <h1 className="text-balance text-4xl font-semibold leading-[1.1] xl:text-5xl">
            Read, write and tip — with nothing to spend on hand.
          </h1>
          <p className="text-lg text-muted-foreground">
            The surface that renders the internet is the one surface that holds
            no key.
          </p>
        </div>

        <div className="space-y-4">
          <p className="eyebrow text-muted-foreground">Why a separate app</p>
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
