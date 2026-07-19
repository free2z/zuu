// The Login-with-Zcash state machine.
//
// A thin wrapper over the shared `useZcashChallengeFlow` stepper
// (challenge → sign → verify — see useZcashChallengeFlow.ts for the crypto),
// specialized for LOGIN: the final verify call is anonymous (`auth.zcashLogin`),
// and success lands the session and navigates home. `useZcashAssociate.ts` is
// the sibling specialization for linking a Zcash key to an already signed-in
// account — it reuses the exact same stepper instead of duplicating it.

import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { auth } from "@/lib/api/free2z";
import { useSession } from "@/store/session";
import {
  STEP_ORDER,
  useZcashChallengeFlow,
  type Phase,
  type StepKey,
  type StepMeta,
  type StepStatus,
  type ZcashChallengeFlowState,
} from "./useZcashChallengeFlow";

export type { Phase, StepKey, StepMeta, StepStatus };
export { STEP_ORDER };

export const STEP_META: Record<StepKey, StepMeta> = {
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
    title: "Verifying",
    detail: "free2z checks the signature against your address and derives your W3C DID.",
  },
};

export type ZcashLoginState = ZcashChallengeFlowState;

export function useZcashLogin(): ZcashLoginState {
  const navigate = useNavigate();
  const setUser = useSession((s) => s.setUser);

  return useZcashChallengeFlow({
    verify: (signed) =>
      auth.zcashLogin({
        address: signed.address,
        challenge: signed.challenge,
        signature: signed.signature,
        pubkey: signed.pubkey,
      }),
    verifyErrorMessage:
      "free2z couldn't verify your Zcash signature. Please try again.",
    onVerified: (user) => setUser(user),
    afterSuccess: async () => {
      toast.success("Welcome to ZUULI", {
        description: "Signed in with your Zcash key.",
      });
      await new Promise((r) => setTimeout(r, 700));
      navigate("/");
    },
  });
}
