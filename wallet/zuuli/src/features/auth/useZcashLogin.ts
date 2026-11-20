import { errorKey } from "@/i18n/errors";
import { translate } from "@/i18n/translate";
import { MESSAGE_KEYS } from "@/i18n/messages";
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
import { setToken } from "@/lib/api/http";
import { useSession } from "@/store/session";
import type { LoginDestination } from "@/lib/auth/login-destination";
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
    get title() {
      return translate(
        MESSAGE_KEYS.featuresAuthUseZcashLoginPreparingYourIdentity,
      );
    },
    get detail() {
      return translate(
        MESSAGE_KEYS.featuresAuthUseZcashLoginLocatingTheZcashKeyThatWillRepresent,
      );
    },
  },
  challenge: {
    key: "challenge",
    get title() {
      return translate(
        MESSAGE_KEYS.featuresAuthUseZcashLoginRequestingAChallenge,
      );
    },
    get detail() {
      return translate(
        MESSAGE_KEYS.featuresAuthUseZcashLoginAskingFree2zForAOneTimeTimestamped,
      );
    },
  },
  sign: {
    key: "sign",
    get title() {
      return translate(
        MESSAGE_KEYS.featuresAuthUseZcashLoginSigningWithYourKey,
      );
    },
    get detail() {
      return translate(
        MESSAGE_KEYS.featuresAuthUseZcashLoginProducingAZIP304SignatureOverThe,
      );
    },
  },
  verify: {
    key: "verify",
    get title() {
      return translate(MESSAGE_KEYS.featuresAuthUseZcashLoginVerifying);
    },
    get detail() {
      return translate(
        MESSAGE_KEYS.featuresAuthUseZcashLoginFree2zChecksTheSignatureAgainstYourAddress,
      );
    },
  },
};

export type ZcashLoginState = ZcashChallengeFlowState;

export function useZcashLogin(
  loginDestination: LoginDestination = "/",
): ZcashLoginState {
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
    verifyErrorMessage: errorKey(
      null,
      MESSAGE_KEYS.featuresAuthUseZcashLoginFree2zCouldnTVerifyYourZcashSignature,
    ),
    onVerified: (session) => {
      if (!session.token)
        throw new Error("Zcash login returned no session token");
      setToken(session.token);
      setUser(session.user);
    },
    afterSuccess: async (_session, _address, isCurrent) => {
      if (!isCurrent()) return;
      toast.success(
        translate(MESSAGE_KEYS.featuresAuthUseZcashLoginWelcomeToZUULI),
        {
          description: translate(
            MESSAGE_KEYS.featuresAuthUseZcashLoginLoggedInWithYourZcashKey,
          ),
        },
      );
      await new Promise((r) => setTimeout(r, 700));
      if (!isCurrent()) return;
      navigate(loginDestination, { replace: true });
    },
  });
}
