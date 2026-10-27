import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import axios from "axios";
let StripeCheckoutButton: typeof import("./StripeCheckoutButton").default;
const previousCheckoutFlag = process.env.REACT_APP_STRIPE_CHECKOUT_ENABLED;
beforeAll(() => {
  process.env.REACT_APP_STRIPE_CHECKOUT_ENABLED = "true";
  StripeCheckoutButton = require("./StripeCheckoutButton").default;
});
afterAll(() => {
  if (previousCheckoutFlag === undefined) {
    delete process.env.REACT_APP_STRIPE_CHECKOUT_ENABLED;
  } else {
    process.env.REACT_APP_STRIPE_CHECKOUT_ENABLED = previousCheckoutFlag;
  }
});

jest.mock("axios");
jest.mock("react-router-dom", () => ({
  useLocation: () => ({ pathname: "/billing" }),
}));
jest.mock("../hooks/useTuziPricing", () => {
  const pricing = {};
  return {
    __esModule: true,
    default: () => ({ pricing }),
    cardFeeCents: () => 0,
    estimatedCardCents: () => 1000,
  };
});
const mocked = axios as jest.Mocked<typeof axios>;
const session = {
  status: 200,
  data: {
    id: "checkout-actor-a",
    url: "https://checkout.stripe.com/c/pay/synthetic",
    quote: {
      checkout_intent_id: "intent-a",
      tuzis: 1000,
      amount_cents: 1000,
      currency: "usd",
      pricing_version: "test",
    },
  },
};
const original = { expectedActorId: 100, expectedUsername: "synthetic-a" };
const next = { expectedActorId: 101, expectedUsername: "synthetic-b" };
let alertSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  alertSpy = jest.spyOn(window, "alert").mockImplementation(() => {});
  mocked.get.mockResolvedValue({ data: { id: 100, username: "synthetic-a" } });
});
afterEach(() => alertSpy.mockRestore());

test("an original actor response arriving after owner props change cannot display its quote", async () => {
  let release!: (value: unknown) => void;
  mocked.post.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }) as any,
  );
  const view = render(<StripeCheckoutButton {...original} />);
  fireEvent.click(screen.getByRole("button", { name: "Review exact charge" }));
  await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(1));
  expect(mocked.post.mock.calls[0][1]).toMatchObject({
    expected_actor_id: 100,
  });
  view.rerender(<StripeCheckoutButton {...next} />);
  await act(async () => release(session));
  expect(
    screen.queryByRole("button", { name: "Continue to Stripe" }),
  ).toBeNull();
});

test("a reviewed quote clears when actor props change", async () => {
  mocked.post.mockResolvedValue(session);
  const view = render(<StripeCheckoutButton {...original} />);
  fireEvent.click(screen.getByRole("button", { name: "Review exact charge" }));
  await screen.findByRole("button", { name: "Continue to Stripe" });
  view.rerender(<StripeCheckoutButton {...next} />);
  expect(
    screen.queryByRole("button", { name: "Continue to Stripe" }),
  ).toBeNull();
});

test("continuing a reviewed quote freshly refuses a switched session", async () => {
  mocked.post.mockResolvedValue(session);
  render(<StripeCheckoutButton {...original} />);
  fireEvent.click(screen.getByRole("button", { name: "Review exact charge" }));
  await screen.findByRole("button", { name: "Continue to Stripe" });
  mocked.get.mockResolvedValue({ data: { id: 101, username: "synthetic-b" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue to Stripe" }));
  await waitFor(() =>
    expect(alertSpy).toHaveBeenCalledWith("Sign in again before continuing."),
  );
  expect(mocked.get).toHaveBeenCalledTimes(2);
  expect(mocked.post).toHaveBeenCalledTimes(1);
});

test("changing quantity while Continue rechecks identity cannot redirect the superseded quote", async () => {
  const originalLocation = Object.getOwnPropertyDescriptor(window, "location")!;
  const redirect = jest.fn();
  Object.defineProperty(window, "location", {configurable: true, value: {...window.location, assign: redirect}});
  try {
    mocked.post.mockResolvedValue(session);
    render(<StripeCheckoutButton {...original} />);
    fireEvent.click(screen.getByRole("button", {name: "Review exact charge"}));
    await screen.findByRole("button", {name: "Continue to Stripe"});
    let release!: (value: unknown) => void;
    mocked.get.mockImplementation(() => new Promise(resolve => {release = resolve}) as any);
    fireEvent.click(screen.getByRole("button", {name: "Continue to Stripe"}));
    await waitFor(() => expect(mocked.get).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByLabelText("Number of Tuzis"), {target: {value: "2000"}});
    await act(async () => release({data: {id: 100, username: "synthetic-a"}}));
    expect(redirect).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", {name: "Continue to Stripe"})).toBeNull();
  } finally {
    Object.defineProperty(window, "location", originalLocation);
  }
});
