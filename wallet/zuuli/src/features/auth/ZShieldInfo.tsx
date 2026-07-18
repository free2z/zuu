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
    title: "Your address is a DID",
    body: "Any Zcash address maps to a W3C Decentralized Identifier (did:zcash). It is yours the moment you generate a key — nobody issues it, nobody can revoke it.",
  },
  {
    icon: KeyRound,
    title: "You prove control by signing",
    body: "To sign in you sign a fresh, one-time challenge with your key using ZIP-304. The signature proves you hold the key without ever revealing it.",
  },
  {
    icon: ShieldCheck,
    title: "No third party in the loop",
    body: "free2z verifies the signature against your address and mints a session. There is no password to leak, no email to harvest, and no identity provider to trust.",
  },
] as const;

export function ZShieldInfo({ children }: { children: React.ReactNode }) {
  return (
    <Dialog>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" aria-hidden />
            ZShield — your key is your identity
          </DialogTitle>
          <DialogDescription>
            Login with Zcash replaces passwords and email with a cryptographic
            proof of control. Here is what actually happens.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-4">
          {POINTS.map(({ icon: Icon, title, body }) => (
            <li key={title} className="flex gap-3">
              <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
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
