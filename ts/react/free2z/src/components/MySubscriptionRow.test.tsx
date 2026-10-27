import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import axios from "axios";
import MySubscriptionRow from "./MySubscriptionRow";
import MySubscriberRow from "./MySubscriberRow";
import { getSubscriptionAvailabilityCopy } from "./subscriptionAvailability";
import { Subscription } from "./MySubscribers";

jest.mock("axios");

const mockedAxios = axios as jest.Mocked<typeof axios>;

function renderRow(row: React.ReactNode) {
  return render(<BrowserRouter>{row}</BrowserRouter>);
}

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  const creator = {
    id: 1,
    username: "state-inactive",
    avatar_image: null,
    p2paddr: "",
    is_active: false,
  };
  const fan = {
    id: 2,
    username: "active-fan",
    avatar_image: null,
    p2paddr: "t1active",
  };
  return {
    star: creator,
    fan,
    max_price: 10,
    expires: new Date(Date.now() + 86400000).toISOString(),
    ...overrides,
  };
}

describe("classic subscription rows with deactivated counterparties", () => {
  beforeEach(() => {
    mockedAxios.delete.mockResolvedValue({ data: {} });
  });

  afterEach(() => jest.clearAllMocks());

  it("names an inactive creator, removes dead actions, and keeps unsubscribe working", async () => {
    const sub = subscription();
    renderRow(<MySubscriptionRow sub={sub} index={0} />);

    expect(screen.getByText("Inactive")).toBeTruthy();
    expect(
      screen.getByText(/creator's account is no longer active/i)
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "state-inactive" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Fund Creator" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "subscription actions" })
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "unsubscribe" }));
    await waitFor(() =>
      expect(mockedAxios.delete).toHaveBeenCalledWith(
        "/api/tuzis/subscribe/state-inactive"
      )
    );
  });

  it("shows an inactive fan without a dead profile or funding action", () => {
    const sub = subscription({
      fan: {
        id: 3,
        username: "fan-inactive",
        avatar_image: null,
        p2paddr: "",
        is_active: false,
      },
    });
    renderRow(<MySubscriberRow sub={sub} index={0} />);

    expect(screen.getByText("Inactive")).toBeTruthy();
    expect(
      screen.getByText(/subscriber's account is no longer active/i)
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "fan-inactive" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "subscriber actions" })
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Fund Creator" })).toBeNull();
  });

  it("preserves active-card actions when is_active is missing from a legacy response", () => {
    const sub = subscription({
      star: {
        id: 4,
        username: "legacy-active",
        avatar_image: null,
        p2paddr: "t1creator",
      },
    });
    renderRow(<MySubscriptionRow sub={sub} index={0} />);

    expect(
      screen.getByRole("link", { name: "legacy-active" }).getAttribute("href")
    ).toBe("/legacy-active");
    fireEvent.click(
      screen.getByRole("button", { name: "subscription actions" })
    );
    expect(screen.getByRole("button", { name: "Fund Creator" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "unsubscribe" })).toBeTruthy();
  });

  it("preserves active subscriber actions when is_active is missing", () => {
    const sub = subscription({
      fan: {
        id: 5,
        username: "legacy-fan",
        avatar_image: null,
        p2paddr: "t1legacyfan",
      },
    });
    renderRow(<MySubscriberRow sub={sub} index={0} />);

    expect(
      screen.getByRole("link", { name: "legacy-fan" }).getAttribute("href")
    ).toBe("/legacy-fan");
    fireEvent.click(screen.getByRole("button", { name: "subscriber actions" }));
    expect(screen.getByRole("button", { name: "Fund Creator" })).toBeTruthy();
  });

  it("provides the unavailable state in all billing locales", () => {
    expect(getSubscriptionAvailabilityCopy("en-US").inactive).toBe("Inactive");
    expect(getSubscriptionAvailabilityCopy("es-MX").inactive).toBe("Inactivo");
    expect(getSubscriptionAvailabilityCopy("fr-CA").inactive).toBe("Inactif");
    expect(getSubscriptionAvailabilityCopy("pt-BR").inactive).toBe("Inativo");
  });
});
