import { translate } from "@/i18n/translate";
import { MESSAGE_KEYS } from "@/i18n/messages";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ApiError } from "@/lib/api/http";
import { CheckoutLinkError } from "@/lib/api/checkout";
import { isTauri } from "@/lib/platform";
import type { CheckoutReturnMode } from "@/lib/checkout/native-return";

interface CheckoutSession {
  url: string;
}

interface StartCardCheckoutOptions {
  authenticated: boolean;
  amount: number;
  returnMode: CheckoutReturnMode;
  createCheckout: (
    amount: number,
    returnMode: CheckoutReturnMode,
  ) => Promise<CheckoutSession>;
  openCheckout: (url: string) => Promise<void>;
}

export type CardCheckoutResult = "sign-in" | "opened";

export class CheckoutOpenError extends Error {
  readonly cause: unknown;

  constructor(cause?: unknown) {
    super(
      translate(
        MESSAGE_KEYS.featuresWalletFundingCardCheckoutTheSecureCheckoutPageCouldNotBe,
      ),
    );
    this.name = "CheckoutOpenError";
    this.cause = cause;
  }
}

/**
 * free2z refuses `zuuli_mobile` with 503 whenever native return issuance is
 * gated off (`ZUULI_NATIVE_CHECKOUT_ENABLED=false`, its state in every
 * environment today) or its dedicated callback host is not yet ready. Without
 * this exactly-once fallback, shipping the native mode would take card
 * checkout on mobile from working to permanently unavailable. Falling back to
 * `web` restores today's behavior — Checkout returns to the Free2Z HTTPS page
 * instead of into the app — and the native path starts being used on its own
 * the moment the server gate flips, with no client release.
 *
 * Only 503 is retried, and only once: a 4xx is the user's problem to fix and a
 * repeat 503 (host policy or Stripe identity, which `web` shares) surfaces the
 * same "temporarily unavailable" message it does today.
 */
async function createNativeOrWebCheckout(
  amount: number,
  returnMode: CheckoutReturnMode,
  createCheckout: StartCardCheckoutOptions["createCheckout"],
): Promise<CheckoutSession> {
  if (returnMode === "web") return createCheckout(amount, "web");
  try {
    return await createCheckout(amount, returnMode);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 503) throw error;
    return createCheckout(amount, "web");
  }
}

/**
 * Keep the authentication boundary outside the protected request. Returning a
 * value instead of navigating here makes the no-request behavior easy to prove.
 */
export async function startCardCheckout({
  authenticated,
  amount,
  returnMode,
  createCheckout,
  openCheckout,
}: StartCardCheckoutOptions): Promise<CardCheckoutResult> {
  if (!authenticated) return "sign-in";
  const { url } = await createNativeOrWebCheckout(
    amount,
    returnMode,
    createCheckout,
  );
  try {
    await openCheckout(url);
  } catch (cause) {
    throw new CheckoutOpenError(cause);
  }
  return "opened";
}

/** Open validated Checkout in the OS browser for Tauri, or navigate on web. */
export async function openCardCheckout(url: string): Promise<void> {
  if (isTauri()) {
    await openUrl(url);
    return;
  }
  // A same-tab navigation is not popup-blocked after the awaited API request,
  // and Stripe returns the web client to the server-controlled currentPath.
  window.location.assign(url);
}

export interface CardCheckoutFeedback {
  title: string;
  description: string;
  signIn: boolean;
}

/** Map technical failure classes to short, distinct recovery instructions. */
export function cardCheckoutFeedback(error: unknown): CardCheckoutFeedback {
  if (
    error instanceof ApiError &&
    (error.status === 401 || error.status === 403)
  ) {
    return {
      title: translate(
        MESSAGE_KEYS.featuresWalletFundingCardCheckoutLogInAgain,
      ),
      description: translate(
        MESSAGE_KEYS.featuresWalletFundingCardCheckoutYourSessionExpiredLogInThenRetry,
      ),
      signIn: true,
    };
  }
  if (
    error instanceof ApiError &&
    (error.status === 400 || error.status === 422)
  ) {
    return {
      title: translate(
        MESSAGE_KEYS.featuresWalletFundingCardCheckoutCheckTheAmount,
      ),
      description: translate(
        MESSAGE_KEYS.featuresWalletFundingCardCheckoutChooseAValidAmountThenTryAgain,
      ),
      signIn: false,
    };
  }
  if (error instanceof ApiError && error.status === 429) {
    return {
      title: translate(
        MESSAGE_KEYS.featuresWalletFundingCardCheckoutTooManyAttempts,
      ),
      description: translate(
        MESSAGE_KEYS.featuresWalletFundingCardCheckoutWaitAMomentBeforeTryingCheckoutAgain,
      ),
      signIn: false,
    };
  }
  if (error instanceof ApiError && error.status >= 500) {
    return {
      title: translate(
        MESSAGE_KEYS.featuresWalletFundingCardCheckoutCheckoutUnavailable,
      ),
      description: translate(
        MESSAGE_KEYS.featuresWalletFundingCardCheckoutThePaymentServiceIsTemporarilyUnavailableTry,
      ),
      signIn: false,
    };
  }
  if (error instanceof CheckoutLinkError) {
    const blocked = error.reason === "untrusted-host";
    return {
      title: blocked
        ? translate(
            MESSAGE_KEYS.featuresWalletFundingCardCheckoutCheckoutLinkBlocked,
          )
        : translate(
            MESSAGE_KEYS.featuresWalletFundingCardCheckoutCheckoutUnavailable,
          ),
      description: blocked
        ? translate(
            MESSAGE_KEYS.featuresWalletFundingCardCheckoutThePaymentLinkWasNotAnApproved,
          )
        : translate(
            MESSAGE_KEYS.featuresWalletFundingCardCheckoutThePaymentServiceReturnedAnInvalidCheckout,
          ),
      signIn: false,
    };
  }
  if (error instanceof CheckoutOpenError) {
    return {
      title: translate(
        MESSAGE_KEYS.featuresWalletFundingCardCheckoutCouldnTOpenCheckout,
      ),
      description: translate(
        MESSAGE_KEYS.featuresWalletFundingCardCheckoutAllowZUULIToOpenExternalLinksThen,
      ),
      signIn: false,
    };
  }
  if (error instanceof TypeError) {
    return {
      title: translate(
        MESSAGE_KEYS.featuresWalletFundingCardCheckoutCanTReachCheckout,
      ),
      description: translate(
        MESSAGE_KEYS.featuresWalletFundingCardCheckoutCheckYourConnectionThenTryAgain,
      ),
      signIn: false,
    };
  }
  return {
    title: translate(
      MESSAGE_KEYS.featuresWalletFundingCardCheckoutCheckoutFailed,
    ),
    description: translate(
      MESSAGE_KEYS.featuresWalletFundingCardCheckoutTryAgainIfThisKeepsHappeningContact,
    ),
    signIn: false,
  };
}
