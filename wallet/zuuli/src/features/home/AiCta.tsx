import { Link } from "react-router-dom";
import { Sparkles, ShieldCheck, Coins, EyeOff, ArrowRight } from "lucide-react";

const POINTS = [
  {
    icon: EyeOff,
    title: "Anonymous by design",
    body: "You talk to free2z; free2z talks to the model. The provider never sees you.",
  },
  {
    icon: Coins,
    title: "Metered in 2Zs",
    body: "Pay the exact upstream cost plus a thin margin, rounded up — no subscription.",
  },
  {
    icon: ShieldCheck,
    title: "Any model, one balance",
    body: "Claude, GPT, Grok, Kimi, or open-source on our hardware — switch freely.",
  },
];

export function AiCta() {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-primary/10 via-card to-fuchsia-600/10 p-6 md:p-8">
      <div className="zuuli-hero-glow pointer-events-none absolute inset-0" aria-hidden />
      <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="max-w-xl space-y-3">
          <div className="inline-flex items-center gap-2 rounded-full bg-primary/15 px-3 py-1 text-xs font-medium text-primary">
            <Sparkles className="h-3.5 w-3.5" aria-hidden />
            Ask any AI, anonymously
          </div>
          <h2 className="text-2xl font-bold tracking-tight md:text-3xl">
            Every model, <span className="zuuli-gradient-text">metered in 2Zs</span>
          </h2>
          <p className="text-sm text-muted-foreground md:text-base">
            Prompt frontier and open-source models through the free2z proxy. No
            account leaks to the provider, and you only pay for the tokens you
            actually use.
          </p>
          <Link
            to="/ai"
            aria-label="Open the AI chat"
            className="group inline-flex h-11 items-center gap-2 rounded-lg bg-primary px-6 text-sm font-semibold text-primary-foreground shadow transition-all hover:bg-primary/90 hover:shadow-glow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Start a conversation
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>
        <ul className="grid shrink-0 gap-3 sm:grid-cols-3 lg:w-[440px] lg:grid-cols-1">
          {POINTS.map(({ icon: Icon, title, body }) => (
            <li
              key={title}
              className="flex items-start gap-3 rounded-xl border border-border bg-card/60 p-3.5 backdrop-blur"
            >
              <span
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary"
                aria-hidden
              >
                <Icon className="h-[18px] w-[18px]" />
              </span>
              <div className="space-y-0.5">
                <div className="text-sm font-semibold">{title}</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {body}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
