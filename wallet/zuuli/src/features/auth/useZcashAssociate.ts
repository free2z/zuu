// Link a Zcash key to the CURRENTLY SIGNED-IN account.
//
// A sibling of `useZcashLogin.ts`: both run the exact same
// challenge → sign → verify stepper (`useZcashChallengeFlow`), so the crypto
// is never duplicated. The only differences are:
//   - the final verify call attaches the session's knox token (NOT anonymous)
//     via `auth.zcashAssociate`, so the backend links the address to this
//     account instead of logging in/creating a new one;
//   - on success we update the signed-in user in place (no navigation — the
//     caller stays on the profile page and shows the linked identity).
//
// The backend (`POST /api/auth/zcash/login/` with a knox token attached)
// returns 409 for either conflict: the address is already linked to another
// account, or this account already has a linked Zcash identity —
// `auth.zcashAssociate` turns both into a single friendly message that lands
// on the "verify" step, same as any other server-side failure.

import { toast } from "sonner";
import { auth } from "@/lib/api/free2z";
import { useSession } from "@/store/session";
import {
  useZcashChallengeFlow,
  type StepMeta,
  type StepKey,
  type ZcashChallengeFlowState,
} from "./useZcashChallengeFlow";

export const LINK_STEP_META: Record<StepKey, StepMeta> = {
  prepare: {
    key: "prepare",
    title: "Preparing your identity",
    detail: "Locating the Zcash key that will represent you. No key ever leaves this device.",
  },
  challenge: {
    key: "challenge",
    title: "Requesting a challenge",
    detail: "Asking free2z for a one-time, timestamped nonce to sign — bound to this session, so it can't be replayed.",
  },
  sign: {
    key: "sign",
    title: "Signing with your key",
    detail: "Producing a ZIP-304 signature over the challenge to prove you control the address.",
  },
  verify: {
    key: "verify",
    title: "Linking to your account",
    detail: "free2z checks the signature and links this Zcash identity to your signed-in account.",
  },
};

export type ZcashAssociateState = ZcashChallengeFlowState;

export function useZcashAssociate(): ZcashAssociateState {
  const setUser = useSession((s) => s.setUser);

  return useZcashChallengeFlow({
    verify: (signed) =>
      auth.zcashAssociate({
        address: signed.address,
        challenge: signed.challenge,
        signature: signed.signature,
        pubkey: signed.pubkey,
      }),
    verifyErrorMessage:
      "free2z couldn't link that Zcash key. Please try again.",
    onVerified: (user) => setUser(user),
    afterSuccess: () => {
      toast.success("Zcash key linked", {
        description: "This Zcash identity is now linked to your account.",
      });
    },
  });
}
