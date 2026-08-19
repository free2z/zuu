import { openUrl } from "@tauri-apps/plugin-opener";
import { ApiError } from "@/lib/api/http";
import { CheckoutLinkError } from "@/lib/api/checkout";
import { isTauri } from "@/lib/platform";

interface CheckoutSession {
  url: string;
}

interface StartCardCheckoutOptions {
  authenticated: boolean;
  amount: number;
  createCheckout: (amount: number) => Promise<CheckoutSession>;
  openCheckout: (url: string) => Promise<void>;
}

export type CardCheckoutResult = "sign-in" | "opened";

export class CheckoutOpenError extends Error {
  readonly cause: unknown;

  constructor(cause?: unknown) {
    super("The secure checkout page could not be opened.");
    this.name = "CheckoutOpenError";
    this.cause = cause;
  }
}

/**
 * Keep the authentication boundary outside the protected request. Returning a
 * value instead of navigating here makes the no-request behavior easy to prove.
 */
export async function startCardCheckout({
  authenticated,
  amount,
  createCheckout,
  openCheckout,
}: StartCardCheckoutOptions): Promise<CardCheckoutResult> {
  if (!authenticated) return "sign-in";
  const { url } = await createCheckout(amount);
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
      title: "Log in again",
      description: "Your session expired. Log in, then retry your purchase.",
      signIn: true,
    };
  }
  if (
    error instanceof ApiError &&
    (error.status === 400 || error.status === 422)
  ) {
    return {
      title: "Check the amount",
      description: "Choose a valid amount, then try again.",
      signIn: false,
    };
  }
  if (error instanceof ApiError && error.status === 429) {
    return {
      title: "Too many attempts",
      description: "Wait a moment before trying checkout again.",
      signIn: false,
    };
  }
  if (error instanceof ApiError && error.status >= 500) {
    return {
      title: "Checkout unavailable",
      description:
        "The payment service is temporarily unavailable. Try again shortly.",
      signIn: false,
    };
  }
  if (error instanceof CheckoutLinkError) {
    const blocked = error.reason === "untrusted-host";
    return {
      title: blocked ? "Checkout link blocked" : "Checkout unavailable",
      description: blocked
        ? "The payment link was not an approved Stripe Checkout address."
        : "The payment service returned an invalid checkout link. Try again shortly.",
      signIn: false,
    };
  }
  if (error instanceof CheckoutOpenError) {
    return {
      title: "Couldn't open checkout",
      description: "Allow ZUULI to open external links, then try again.",
      signIn: false,
    };
  }
  if (error instanceof TypeError) {
    return {
      title: "Can't reach checkout",
      description: "Check your connection, then try again.",
      signIn: false,
    };
  }
  return {
    title: "Checkout failed",
    description: "Try again. If this keeps happening, contact support.",
    signIn: false,
  };
}
