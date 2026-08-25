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
    <aside className="relative hidden flex-col justify-between border-e border-border bg-background p-10 lg:flex xl:p-14">
      <Wordmark />

      <div className="relative max-w-md space-y-10">
        <div className="space-y-3">
          <h1 className="text-balance text-4xl font-semibold leading-[1.1] xl:text-5xl">
            Log in your way — including with just your key.
          </h1>
          <p className="text-lg text-muted-foreground">{APP_TAGLINE}</p>
        </div>

        <div className="space-y-4">
          <p className="eyebrow text-muted-foreground">Why Zcash</p>
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
