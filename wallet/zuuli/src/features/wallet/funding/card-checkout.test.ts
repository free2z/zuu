import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/http";
import {
  CheckoutLinkError,
  stripeCheckoutHosts,
  validateStripeCheckoutUrl,
} from "@/lib/api/checkout";
import {
  CheckoutOpenError,
  cardCheckoutFeedback,
  startCardCheckout,
} from "./card-checkout";

describe("card checkout authentication boundary", () => {
  it("routes a signed-out user to sign-in without calling checkout or opener", async () => {
    const createCheckout = vi.fn();
    const openCheckout = vi.fn();

    await expect(
      startCardCheckout({
        authenticated: false,
        amount: 2_000,
        createCheckout,
        openCheckout,
      }),
    ).resolves.toBe("sign-in");
    expect(createCheckout).not.toHaveBeenCalled();
    expect(openCheckout).not.toHaveBeenCalled();
  });

  it("opens the validated backend URL directly for a signed-in user", async () => {
    const url = "https://checkout.stripe.com/c/pay/cs_test_123?prefilled=true";
    const openCheckout = vi.fn().mockResolvedValue(undefined);

    await expect(
      startCardCheckout({
        authenticated: true,
        amount: 2_000,
        createCheckout: vi.fn().mockResolvedValue({ url }),
        openCheckout,
      }),
    ).resolves.toBe("opened");
    expect(openCheckout).toHaveBeenCalledOnce();
    expect(openCheckout).toHaveBeenCalledWith(url);
  });
});

describe("Stripe Checkout URL policy", () => {
  const customHosts = stripeCheckoutHosts("pay.free2z.cash");

  it.each([
    "https://checkout.stripe.com/c/pay/cs_test_123?key=value",
    "https://pay.free2z.cash/session/cs_test_123",
  ])("accepts an exact configured HTTPS host: %s", (url) => {
    expect(validateStripeCheckoutUrl(url, customHosts)).toBe(url);
  });

  it.each([
    ["suffix", "https://checkout.stripe.com.evil.example/session"],
    ["userinfo", "https://checkout.stripe.com@evil.example/session"],
    [
      "userinfo on allowed host",
      "https://evil.example@checkout.stripe.com/session",
    ],
    ["explicit port", "https://checkout.stripe.com:443/session"],
    ["non-default port", "https://checkout.stripe.com:8443/session"],
    ["scheme", "http://checkout.stripe.com/session"],
    ["protocol-relative", "//checkout.stripe.com/session"],
    ["fragment", "https://checkout.stripe.com/session#redirect"],
    ["wildcard-like custom host", "https://sub.pay.free2z.cash/session"],
    ["parser control character", "https://checkout.stripe.com\t/session"],
  ])("rejects %s tricks", (_name, url) => {
    expect(() => validateStripeCheckoutUrl(url, customHosts)).toThrow(
      CheckoutLinkError,
    );
  });

  it.each([undefined, null, "", "not a URL", " https://checkout.stripe.com/"])(
    "rejects a missing or malformed checkout URL: %s",
    (url) => {
      expect(() => validateStripeCheckoutUrl(url, customHosts)).toThrow(
        CheckoutLinkError,
      );
    },
  );

  it("ignores invalid custom-domain configuration", () => {
    const hosts = stripeCheckoutHosts(
      "*.example.com,https://pay.example.com,pay.example.com:443,pay.free2z.cash",
    );
    expect([...hosts]).toEqual(["checkout.stripe.com", "pay.free2z.cash"]);
  });
});

describe("card checkout failure guidance", () => {
  it.each([401, 403])(
    "sends an HTTP %i session failure back to sign-in",
    (status) => {
      expect(cardCheckoutFeedback(new ApiError(status, "auth"))).toMatchObject({
        title: "Log in again",
        signIn: true,
      });
    },
  );

  it("distinguishes network, server, hostile-link and opener failures", () => {
    expect(cardCheckoutFeedback(new TypeError("fetch failed")).title).toBe(
      "Can't reach checkout",
    );
    expect(cardCheckoutFeedback(new ApiError(503, "down")).title).toBe(
      "Checkout unavailable",
    );
    expect(
      cardCheckoutFeedback(new CheckoutLinkError("untrusted-host")).title,
    ).toBe("Checkout link blocked");
    expect(cardCheckoutFeedback(new CheckoutOpenError()).title).toBe(
      "Couldn't open checkout",
    );
  });
});
