// Left-hand cinematic brand panel — the pitch for keys-as-identity. Hidden on
// small screens where the action panel takes the full viewport.

import { EyeOff, Fingerprint, KeyRound, ShieldCheck } from "lucide-react";
import { Wordmark } from "@/components/brand/Logo";
import { APP_TAGLINE, COMPANY } from "@/lib/env";

const VALUES = [
  {
    icon: Fingerprint,
    title: "Your key is your identity",
    body: "One Zcash key signs you in everywhere. No account to be granted or taken away.",
  },
  {
    icon: EyeOff,
    title: "No email, no password, no KYC",
    body: "Nothing to phish, leak, or reset. There is simply nothing on file to lose.",
  },
  {
    icon: KeyRound,
    title: "W3C DID + ZIP-304 signatures",
    body: "Open standards, not a proprietary login. Your address is a decentralized identifier.",
  },
  {
    icon: ShieldCheck,
    title: "Anonymous by design",
    body: "Prove control without revealing who you are. Privacy is the default, not a setting.",
  },
] as const;

export function BrandPanel() {
  return (
    <aside className="zuuli-hero-glow relative hidden flex-col justify-between overflow-hidden border-r border-border bg-background p-10 lg:flex xl:p-14">
      {/* Ambient glow accents */}
      <div
        className="pointer-events-none absolute -left-24 top-1/3 h-72 w-72 rounded-full bg-primary/20 blur-3xl"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -right-16 bottom-10 h-64 w-64 rounded-full bg-fuchsia-600/10 blur-3xl"
        aria-hidden
      />

      <Wordmark />

      <div className="relative max-w-md space-y-10">
        <div className="space-y-3">
          <h1 className="text-balance text-4xl font-bold leading-[1.1] tracking-tight xl:text-5xl">
            The <span className="zuuli-gradient-text">future of login</span> has
            no password.
          </h1>
          <p className="text-lg text-muted-foreground">{APP_TAGLINE}</p>
        </div>

        <ul className="space-y-5">
          {VALUES.map(({ icon: Icon, title, body }) => (
            <li key={title} className="flex gap-3.5">
              <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
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

      <p className="relative text-xs text-muted-foreground">
        © {new Date().getFullYear()} {COMPANY}
      </p>
    </aside>
  );
}
