//  for the CLASSIC bundle. Issue  names this exact call site, and
// classic is reachable: nginx serves it from `^~ /classic-ui/` and from
// `@classic_fallback` on `location /` whenever the SSR app is unavailable.
//
// The failure it fixes: creator sets 10, the fan's dialog renders "For 10
// 2Zs per month", the creator raises the price to 999999, the fan clicks
// SUBSCRIBE on the page they already had open, and the legacy price-less POST
// charges 999999 -- every server-side check passing, because the request
// itself resolves the new price. member_price allows six digits.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import axios from "axios";
import { readFileSync } from "fs";
import { join } from "path";

const mockNavigate = jest.fn();
const mockSetFan = jest.fn();
const mockSetSnackbar = jest.fn();

let mockFan: any = { id: 100, username: "fan", tuzis: "1000000" };

jest.mock("react-router", () => ({
  useLocation: () => ({ pathname: "/astar" }),
}));
jest.mock("../hooks/useTransitionNavigate", () => ({
  useTransitionNavigate: () => mockNavigate,
}));
jest.mock("../state/global", () => ({
  useGlobalState: (key: string) =>
    key === "creator" ? [mockFan, mockSetFan] : [null, mockSetSnackbar],
}));
jest.mock("./TuzisButton", () => ({
  __esModule: true,
  default: () => <div>tuzis</div>,
}));
jest.mock("./LoginMessageStack", () => ({
  __esModule: true,
  default: () => <div>login</div>,
}));
jest.mock("axios");

import { CreatorSubscribeContent } from "./SubscribeToCreator";
import {
  clearSubscribeIdempotencyKey,
  retireResolvedSubscribeIdempotencyKeys,
  SubscriptionIdempotencyStorageError,
  subscribeIdempotencyHeaders,
} from "../subscribeIdempotency";
import { PublicCreator } from "../CreatorDetail";

const star = {
  id: 200,
  username: "astar",
  is_verified: false,
  total: 0,
  full_name: "A Star",
  description: "",
  p2paddr: "",
  zpages: 0,
  member_price: "10",
  can_stream: false,
  avatar_image: null,
  banner_image: null,
} as PublicCreator;

const mocked = axios as jest.Mocked<typeof axios>;

function renderDialog() {
  return render(
    <CreatorSubscribeContent
      showPay={true}
      setShowPay={jest.fn()}
      star={star}
    />
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  // The module's in-memory fallback is module state and survives
  // localStorage.clear(), so a key stranded there by the storage-failure
  // test below would leak into the next one.
  clearSubscribeIdempotencyKey("astar");
  clearSubscribeIdempotencyKey("bstar");
  mockFan = { id: 100, username: "fan", tuzis: "1000000" };
  mocked.get.mockResolvedValue({ data: mockFan } as any);
});

it("uses immutable creator and payer ids for the shared subscription slot", () => {
  const identity = {
    creatorId: 200,
    payerId: 100,
    username: "astar",
    payerUsername: "fan",
  };
  const first = subscribeIdempotencyHeaders(identity)["Idempotency-Key"];
  const renamed = subscribeIdempotencyHeaders({
    ...identity,
    username: "renamed-star",
  })["Idempotency-Key"];
  expect(() =>
    subscribeIdempotencyHeaders({
      ...identity,
      payerId: 101,
    })
  ).toThrow("another account");
  expect(subscribeIdempotencyHeaders(identity)["Idempotency-Key"]).toBe(first);
  clearSubscribeIdempotencyKey(identity);
  const otherAccount = subscribeIdempotencyHeaders({
    ...identity,
    payerId: 101,
  })["Idempotency-Key"];
  expect(otherAccount).not.toBe(first);
  clearSubscribeIdempotencyKey({ ...identity, payerId: 101 });
  expect(renamed).toBe(first);
  expect(
    subscribeIdempotencyHeaders({ ...identity, payerId: 101 })[
      "Idempotency-Key"
    ]
  ).not.toBe(first);
});

it("a delayed response cannot settle a newer adopted subscription key", () => {
    const identity = { creatorId: 200, payerId: 100, username: "astar", payerUsername: "fan" }
    const keyA = subscribeIdempotencyHeaders(identity)["Idempotency-Key"]
    const keyAFromSecondTab = subscribeIdempotencyHeaders(identity)["Idempotency-Key"]
    expect(keyAFromSecondTab).toBe(keyA)

    // One response settles A, then an old bundle leaves a
    // legacy receipt that the next purchase adopts as B's superseded evidence.
    clearSubscribeIdempotencyKey(identity, { expectedKey: keyA })
    localStorage.setItem("f2z:subscribe-idempotency:astar", "f2z-late-legacy-key")
    const keyBHeaders = subscribeIdempotencyHeaders(identity)
    expect(keyBHeaders["Idempotency-Key"]).not.toBe(keyA)
    expect(keyBHeaders["X-Superseded-Idempotency-Key"]).toBe("f2z-late-legacy-key")
    const adoptionName = Object.keys(localStorage).find((name) =>
        name.startsWith("f2z:subscribe-idempotency-adoption:"),
    )!
    const adoptionBeforeLateResponse = localStorage.getItem(adoptionName)

    // The second tab's delayed result for A must not clear B or settle the
    // adopted legacy receipt (which is sent as B's superseded key).
    clearSubscribeIdempotencyKey(identity, { expectedKey: keyA })

    expect(subscribeIdempotencyHeaders(identity)).toEqual(keyBHeaders)
    expect(localStorage.getItem(adoptionName)).toBe(adoptionBeforeLateResponse)
    expect(JSON.parse(adoptionBeforeLateResponse!).settled).toBe(false)
    expect(localStorage.getItem("f2z:subscribe-idempotency-superseded:astar"))
        .toBe("f2z-late-legacy-key")
})

it("adopts a loaded legacy key once and records durable settlement", () => {
  const identity = { creatorId: 200, payerId: 100, username: "astar" };
  const legacy = "f2z-legacy-loaded-key";
  localStorage.setItem("f2z:subscribe-idempotency:astar", legacy);

  const headers = subscribeIdempotencyHeaders(identity);
  expect(headers["X-Superseded-Idempotency-Key"]).toBe(legacy);
  const markerName = Object.keys(localStorage).find((name) =>
    name.startsWith("f2z:subscribe-idempotency-adoption:")
  );
  expect(markerName).toBeDefined();
  expect(JSON.parse(localStorage.getItem(markerName!)!)).toMatchObject({
    key: legacy,
    keys: [legacy, headers["Idempotency-Key"]],
    settled: false,
  });

  clearSubscribeIdempotencyKey(identity);
  expect(localStorage.getItem(markerName!)).toBeNull();
  const renewed = subscribeIdempotencyHeaders(identity);
  expect(renewed["Idempotency-Key"]).not.toBe(headers["Idempotency-Key"]);
  expect(renewed["X-Superseded-Idempotency-Key"]).toBeUndefined();
  expect(JSON.parse(localStorage.getItem(markerName!)!)).toMatchObject({
    key: renewed["Idempotency-Key"],
    keys: [renewed["Idempotency-Key"]],
    settled: false,
  });
});

it("a delayed clear cannot retire a newer adopted subscription key", () => {
  const identity = {
    creatorId: 200,
    payerId: 100,
    username: "delayed-owner",
    payerUsername: "fan",
  };
  const destination = `f2z:subscribe-idempotency:v2:${encodeURIComponent(
    JSON.stringify({ creator: "200", payer: "100" })
  )}`;
  const adoption = `f2z:subscribe-idempotency-adoption:${encodeURIComponent(
    destination
  )}`;
  const older = "11111111-2222-4333-8444-555555555555";
  const newer = "66666666-7777-4888-8999-000000000000";
  localStorage.setItem(destination, newer);
  localStorage.setItem(
    adoption,
    JSON.stringify({ key: newer, keys: [older, newer], settled: false })
  );
  for (const key of [older, newer]) {
    localStorage.setItem(
      `f2z:subscribe-idempotency-adoption-owner:${encodeURIComponent(key)}`,
      JSON.stringify({ creatorId: "200", payerId: "100", settled: false })
    );
  }

  clearSubscribeIdempotencyKey(identity, { key: older });

  expect(localStorage.getItem(destination)).toBe(newer);
  expect(JSON.parse(localStorage.getItem(adoption)!)).toMatchObject({
    key: newer,
    keys: [newer],
    settled: false,
  });
  expect(subscribeIdempotencyHeaders(identity)["Idempotency-Key"]).toBe(
    newer
  );
});

it("keeps legacy evidence when the stable destination already has a UUID", () => {
  const identity = {
    creatorId: 200,
    payerId: 100,
    username: "astar",
    payerUsername: "fan",
  };
  const first = subscribeIdempotencyHeaders(identity);
  localStorage.setItem(
    "f2z:subscribe-idempotency-superseded:astar",
    "f2z-old-paid"
  );

  const retry = subscribeIdempotencyHeaders(identity);
  expect(retry["Idempotency-Key"]).toBe(first["Idempotency-Key"]);
  expect(retry["X-Superseded-Idempotency-Key"]).toBe("f2z-old-paid");
});

it("globally binds legacy adoption to both immutable identities", () => {
  localStorage.setItem("f2z:subscribe-idempotency:astar", "f2z-old-paid");
  const owner = {
    creatorId: 200,
    payerId: 100,
    username: "astar",
    payerUsername: "fan",
  };
  subscribeIdempotencyHeaders(owner);

  expect(() =>
    subscribeIdempotencyHeaders({
      ...owner,
      creatorId: 201,
    })
  ).toThrow("another account or creator");
  expect(() =>
    subscribeIdempotencyHeaders({
      ...owner,
      payerId: 101,
      payerUsername: "other",
    })
  ).toThrow("another account");
});

it("fails closed when a foreign UUID occupies the shared legacy slot", () => {
  const foreign = "77777777-7777-4777-8777-777777777777";
  localStorage.setItem("f2z:subscribe-idempotency:astar", foreign);
  localStorage.setItem(
    `f2z:subscribe-idempotency-adoption-owner:${foreign}`,
    JSON.stringify({ creatorId: 200, payerId: 101, settled: false })
  );

  expect(() =>
    subscribeIdempotencyHeaders({
      creatorId: 200,
      payerId: 100,
      username: "astar",
      payerUsername: "fan",
    })
  ).toThrow("another account");
  expect(localStorage.getItem("f2z:subscribe-idempotency:astar")).toBe(
    foreign
  );
});

it("does not delete a stable receipt when adoption metadata cannot be read", () => {
  const values = new Map<string, string>();
  let failReads = false;
  const identity = { creatorId: 200, payerId: 100, username: "astar" };
  const storage = {
    getItem(name: string) {
      if (failReads && name.startsWith("f2z:subscribe-idempotency-adoption:")) {
        throw new Error("blocked read");
      }
      return values.get(name) ?? null;
    },
    setItem(name: string, value: string) {
      values.set(name, String(value));
    },
    removeItem(name: string) {
      values.delete(name);
    },
  } as Storage;
  const key = subscribeIdempotencyHeaders(identity, { storage })[
    "Idempotency-Key"
  ];

  failReads = true;
  clearSubscribeIdempotencyKey(identity, { storage });
  const destination = Array.from(values.keys()).find((name) =>
    name.startsWith("f2z:subscribe-idempotency:v2:")
  );
  expect(destination).toBeDefined();
  expect(values.has(destination!)).toBe(true);
  expect(key).toMatch(/^[-0-9a-f]+$/);
});

it("blocks a paid request when durable subscription storage rejects a new key", () => {
  jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  expect(() =>
    subscribeIdempotencyHeaders({
      creatorId: 200,
      payerId: 100,
      username: "astar",
    })
  ).toThrow(SubscriptionIdempotencyStorageError);
});

// The storage-failure test below spies on Storage.prototype; clearAllMocks
// resets calls but not implementations, so a leaked spy would silently break
// every later test in this file.
afterEach(() => {
  jest.restoreAllMocks();
});

it("recovers the first UUID after the second durable write fails before POST", async () => {
  const setItem = Storage.prototype.setItem;
  let writes = 0;
  const write = jest
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, name, value) {
      writes += 1;
      if (writes === 2) throw new Error("quota");
      setItem.call(this, name, value);
    });
  mocked.post.mockResolvedValue({ data: { charged: true } } as any);
  renderDialog();
  fireEvent.click(screen.getByText("SUBSCRIBE"));
  expect(mocked.post).not.toHaveBeenCalled();
  const slot = Object.keys(localStorage).find((name) =>
    name.startsWith("f2z:subscribe-idempotency:v2:")
  )!;
  const first = localStorage.getItem(slot);
  expect(first).toMatch(/^[0-9a-f-]{36}$/);
  expect(mockSetSnackbar).toHaveBeenCalledWith(
    expect.objectContaining({
      message: expect.stringContaining("This attempt was not sent"),
    })
  );
  write.mockRestore();
  fireEvent.click(screen.getByText("SUBSCRIBE"));
  await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(1));
  expect((mocked.post.mock.calls[0][2] as any).headers["Idempotency-Key"]).toBe(
    first
  );
});

it("blocks a separate purchase while a foreign payer's shared evidence is unresolved", async () => {
  const owner = {
    creatorId: star.id,
    payerId: 100,
    username: "astar",
    payerUsername: "fan",
  };
  subscribeIdempotencyHeaders(owner);
  mockFan = { ...mockFan, id: 101, username: "other" };
  mocked.post.mockResolvedValue({ data: { charged: true } } as any);
  const rendered = renderDialog();
  fireEvent.click(screen.getByText("SUBSCRIBE"));
  await waitFor(() => expect(mocked.post).not.toHaveBeenCalled());
  rendered.unmount();
});

it("buys on the price-bound route, sending the price it rendered", async () => {
  mocked.post.mockResolvedValue({
    data: { charged: true, replayed: false },
  } as any);

  renderDialog();
  // The dialog showed 10, so 10 is what the fan confirmed.
  expect(screen.getByText(/For 10 2Zs per month/)).toBeTruthy();
  fireEvent.click(screen.getByText("SUBSCRIBE"));

  await waitFor(() => expect(mocked.post).toHaveBeenCalled());
  const [url, body, options] = mocked.post.mock.calls[0];
  // The legacy route carries no price at all; it must not be used here.
  expect(url).toBe("/api/tuzis/subscribe-confirmed/astar");
  expect(body).toEqual({ expected_price: "10", creator_id: 200 });
  expect((options as any).headers["Idempotency-Key"]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
});
it("refuses to charge a price the fan never saw, and asks again", async () => {
  mocked.post.mockRejectedValue({
    response: {
      status: 409,
      data: { code: "price_changed", current_price: "999999" },
    },
  });

  renderDialog();
  fireEvent.click(screen.getByText("SUBSCRIBE"));

  // Nothing charged, and the dialog now shows the NEW number instead of
  // silently retrying with it.
  await waitFor(() =>
    expect(screen.getByText(/For 999999 2Zs per month/)).toBeTruthy()
  );
  expect(mockSetFan).not.toHaveBeenCalled();
  expect(mocked.post).toHaveBeenCalledTimes(1);
  expect(
    screen.getByText(/Review the new price and confirm again/)
  ).toBeTruthy();

  // A second, deliberate confirmation sends the NEW price -- never the old.
  mocked.post.mockResolvedValue({
    data: { charged: true, replayed: false },
  } as any);
  fireEvent.click(screen.getByText("SUBSCRIBE"));
  await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(2));
  expect(mocked.post.mock.calls[1][1]).toEqual({
    expected_price: "999999",
    creator_id: 200,
  });
});

it("reuses one key across a retry, and retires it only on success", async () => {
  mocked.post.mockRejectedValue({
    response: { status: 409, data: { code: "request_in_progress" } },
  });

  let view = renderDialog();
  fireEvent.click(screen.getByText("SUBSCRIBE"));
  await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(1));
  const first = (mocked.post.mock.calls[0][2] as any).headers[
    "Idempotency-Key"
  ];
  // An already-loaded older dialog must send this same UUID after the
  // new dialog lost its response, not mint a second payment identity.
  expect(subscribeIdempotencyHeaders("astar", "fan")["Idempotency-Key"]).toBe(
    first
  );
  // An undecided answer must not invite another click from this dialog.
  expect(
    (screen.getByText("SUBSCRIBE").closest("button") as HTMLButtonElement)
      .disabled
  ).toBe(true);

  // The user reloads and clicks again -- the retry the abort copy asks for.
  view.unmount();
  mocked.post.mockResolvedValue({
    data: { charged: true, replayed: true },
  } as any);
  view = renderDialog();
  fireEvent.click(screen.getByText("SUBSCRIBE"));
  await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(2));
  const second = (mocked.post.mock.calls[1][2] as any).headers[
    "Idempotency-Key"
  ];
  // A fresh UUID per click sends the header and protects nothing.
  expect(second).toBe(first);

  // Resolved, so the next purchase is a genuinely new one.
  view.unmount();
  view = renderDialog();
  fireEvent.click(screen.getByText("SUBSCRIBE"));
  await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(3));
  expect(
    (mocked.post.mock.calls[2][2] as any).headers["Idempotency-Key"]
  ).not.toBe(first);
});

it("preserves recovery after an uncertain 402 and lets the switched payer subscribe", async () => {
  mocked.post
    .mockRejectedValueOnce({
      response: {
        status: 402,
        data: { error: "The payment outcome could not be confirmed." },
      },
    })
    .mockResolvedValueOnce({ data: { status: "abandoned" } } as any)
    .mockResolvedValueOnce({ data: { charged: true, replayed: false } } as any);

  const view = renderDialog();
  fireEvent.click(screen.getByText("SUBSCRIBE"));
  await waitFor(() =>
    expect(screen.getByText("Resolve previous attempt")).toBeTruthy()
  );
  const firstKey = (mocked.post.mock.calls[0][2] as any).headers[
    "Idempotency-Key"
  ];

  fireEvent.click(screen.getByText("Resolve previous attempt"));
  await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(2));
  expect(mocked.post.mock.calls[1][0]).toBe(
    "/api/tuzis/subscribe-recovery/200"
  );
  expect(mocked.post.mock.calls[1][1]).toEqual(
    expect.objectContaining({ username: "astar" })
  );
  await waitFor(() => expect(screen.getByText("SUBSCRIBE")).toBeTruthy());

  // The server-backed abandonment is complete. Switching accounts in the
  // same browser must not inherit A's key or private result; B gets its own
  // authenticated stable intent and can proceed normally.
  mockFan = { id: 101, username: "other", tuzis: "1000000" };
  view.rerender(
    <CreatorSubscribeContent
      showPay={true}
      setShowPay={jest.fn()}
      star={star}
    />
  );
  fireEvent.click(screen.getByText("SUBSCRIBE"));
  await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(3));
  expect(mocked.post.mock.calls[2][0]).toBe(
    "/api/tuzis/subscribe-confirmed/astar"
  );
  expect(
    (mocked.post.mock.calls[2][2] as any).headers["Idempotency-Key"]
  ).not.toBe(firstKey);
});

it("does not offer recovery for a confirmed insufficient-funds 402", async () => {
  mocked.post.mockRejectedValueOnce({
    response: {
      status: 402,
      data: { code: "insufficient_funds", error: "Not enough 2Z." },
    },
  });

  renderDialog();
  fireEvent.click(screen.getByText("SUBSCRIBE"));

  await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(1));
  expect(screen.queryByText("Resolve previous attempt")).toBeNull();
});

it("settles a historical key it can no longer send instead of retaining it", async () => {
  // What 's client minted in any browser without crypto.randomUUID.
  // Sending it is 400 invalid_idempotency_key now, but the receipt it may
  // have is the only evidence the earlier charge happened.
  localStorage.setItem("f2z:subscribe-idempotency:astar", "f2z-lz4k9x-0.82");
  mocked.post.mockResolvedValue({
    data: { charged: true, replayed: true },
  } as any);

  renderDialog();
  fireEvent.click(screen.getByText("SUBSCRIBE"));

  await waitFor(() => expect(mocked.post).toHaveBeenCalled());
  const headers = (mocked.post.mock.calls[0][2] as any).headers;
  expect(headers["X-Superseded-Idempotency-Key"]).toBe("f2z-lz4k9x-0.82");
  expect(headers["Idempotency-Key"]).not.toBe("f2z-lz4k9x-0.82");

  // The server acknowledged the replacement key, so the historical handle
  // is settled and retired together with the replacement.
  await waitFor(() =>
    expect(
      localStorage.getItem("f2z:subscribe-idempotency-superseded:astar")
    ).toBeNull()
  );
  expect(localStorage.getItem("f2z:subscribe-idempotency:astar")).toBeNull();
});

it("blocks an ambiguous paid request when legacy adoption cannot persist", async () => {
  // Codex adversarial review, round 2. A store that hands back an old
  // non-UUID value and rejects every mutation (private modes, quota,
  // policy) must not produce a new UUID that the stable slot cannot retain.
  // A paid request without durable retry evidence is ambiguous.
  localStorage.setItem("f2z:subscribe-idempotency:astar", "f2z-stuck");
  jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("QuotaExceededError");
  });

  let view = renderDialog();
  fireEvent.click(screen.getByText("SUBSCRIBE"));
  await waitFor(() => expect(mocked.post).not.toHaveBeenCalled());

  view.unmount();
  view = renderDialog();
  fireEvent.click(screen.getByText("SUBSCRIBE"));
  await waitFor(() => expect(mocked.post).not.toHaveBeenCalled());
  expect(localStorage.getItem("f2z:subscribe-idempotency:astar")).toBe(
    "f2z-stuck"
  );
});

it("retires a key an observed membership has already resolved", async () => {
  // Codex adversarial review, round 2. A purchase whose response was lost
  // never reaches the success handler, so its key survives -- and the
  // completed receipt binds that key to the price paid. Once the membership
  // expires and the creator has moved their price, every new attempt sends
  // the same key with a different `expected_price` and is answered 409
  // idempotency_mismatch, forever, with no reload able to clear it.
  // Observing the ACTIVE membership is the resolution the success handler
  // never got.
  localStorage.setItem("f2z:subscribe-idempotency:astar", "f2z-legacy");
  const stranded = subscribeIdempotencyHeaders("astar", "fan");
  expect(stranded["X-Superseded-Idempotency-Key"]).toBe("f2z-legacy");

  retireResolvedSubscribeIdempotencyKeys(["astar", "bstar"], "fan");

  expect(localStorage.getItem("f2z:subscribe-idempotency:astar")).toBe(null);
  expect(
    localStorage.getItem("f2z:subscribe-idempotency-superseded:astar")
  ).toBe(null);
  const afterwards = subscribeIdempotencyHeaders("astar", "fan");
  expect(afterwards["Idempotency-Key"]).not.toBe(stranded["Idempotency-Key"]);
  expect(afterwards["X-Superseded-Idempotency-Key"]).toBeUndefined();

  // Nothing to retire is not an error: the fan may hold no memberships.
  retireResolvedSubscribeIdempotencyKeys(undefined, "fan");
});

it("another account's membership cannot retire this fan's key", async () => {
  // Codex adversarial review, round 5. localStorage is per BROWSER, so an
  // app-wide membership sweep must address the stable creator+payer slot.
  // Account A's lost purchase strands its key; account B logs in already
  // subscribed to that creator; the sweep must not delete A's evidence.
  const held = subscribeIdempotencyHeaders("astar", "alice")["Idempotency-Key"];

  retireResolvedSubscribeIdempotencyKeys(["astar"], "bob");

  expect(subscribeIdempotencyHeaders("astar", "alice")["Idempotency-Key"]).toBe(
    held
  );

  // Alice's own membership still resolves Alice's own key.
  retireResolvedSubscribeIdempotencyKeys(["astar"], "alice");
  expect(
    subscribeIdempotencyHeaders("astar", "alice")["Idempotency-Key"]
  ).not.toBe(held);
});

it("a key with no recorded payer is kept, not swept", async () => {
  // What a key minted by an earlier build looks like. Keeping it is the
  // safe direction: it can only replay a charge that happened, and the
  // server's `key_resolved: true` retires it on the next attempt.
  localStorage.setItem(
    "f2z:subscribe-idempotency:astar",
    "11111111-1111-4111-8111-111111111111"
  );

  retireResolvedSubscribeIdempotencyKeys(["astar"], "alice");

  expect(localStorage.getItem("f2z:subscribe-idempotency:astar")).toBe(
    "11111111-1111-4111-8111-111111111111"
  );
});

it("the app-wide auth read is what performs that reconciliation", () => {
  // A source assertion: GlobalCreator is the only component mounted for the
  // whole app that holds the authoritative `stars` list. The subscribe
  // dialog is NOT mounted while the fan is subscribed (CreatorSupport
  // renders YouAreSubscribed instead), so an effect there could never see
  // the membership it is waiting for. Rendering GlobalCreator here would
  // mean standing up react-query and the WebSocket provider for one line.
  const source = readFileSync(
    join(__dirname, "..", "state", "GlobalCreator.tsx"),
    "utf8"
  );
  expect(source).toMatch(
    /retireResolvedSubscribeIdempotencyKeys\(\s*data\.stars,\s*data\.id,\s*data\.star_ids,\s*data\.username,?\s*\)/
  );
});

it("retires a key the server proved is spent on a settled request", async () => {
  // Codex adversarial review, round 3. Without this the fan is stuck: the
  // completed receipt binds the key to last month's price, so every attempt
  // at the new price is 409 idempotency_mismatch for the receipt's whole
  // 365-day horizon and no reload clears it.
  mocked.post.mockRejectedValueOnce({
    response: {
      status: 409,
      data: { code: "idempotency_mismatch", key_resolved: true },
    },
  });

  renderDialog();
  fireEvent.click(screen.getByText("SUBSCRIBE"));
  await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(1));
  const stale = (mocked.post.mock.calls[0][2] as any).headers[
    "Idempotency-Key"
  ];

  // Still clickable, and the next click carries a genuinely new key.
  await waitFor(() =>
    expect(
      (screen.getByText("SUBSCRIBE").closest("button") as HTMLButtonElement)
        .disabled
    ).toBe(false)
  );
  mocked.post.mockResolvedValue({
    data: { charged: true, replayed: false },
  } as any);
  fireEvent.click(screen.getByText("SUBSCRIBE"));
  await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(2));
  expect(
    (mocked.post.mock.calls[1][2] as any).headers["Idempotency-Key"]
  ).not.toBe(stale);
});

it("keeps a key the server has NOT resolved", async () => {
  // `key_resolved: false` means the other request may still be committing.
  // Minting a new key there is the double charge the key exists to prevent.
  mocked.post.mockRejectedValue({
    response: {
      status: 409,
      data: { code: "idempotency_mismatch", key_resolved: false },
    },
  });

  let view = renderDialog();
  fireEvent.click(screen.getByText("SUBSCRIBE"));
  await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(1));
  const held = (mocked.post.mock.calls[0][2] as any).headers["Idempotency-Key"];
  expect(
    (screen.getByText("SUBSCRIBE").closest("button") as HTMLButtonElement)
      .disabled
  ).toBe(true);

  view.unmount();
  view = renderDialog();
  fireEvent.click(screen.getByText("SUBSCRIBE"));
  await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(2));
  expect((mocked.post.mock.calls[1][2] as any).headers["Idempotency-Key"]).toBe(
    held
  );
});

// Adversarial review of: `member_price` is nullable, `Number(null)` is
// 0, so the affordability gate passed for every fan and SUBSCRIBE rendered
// for a creator selling nothing. On the legacy route that click answered
// "Creator did not set member price"; on the confirmed route `expected_price`
// has `min_value=1`, so the fan is shown the serializer's field name in a
// snackbar. No request should leave at all.
it("sells nothing, and says so, for a creator with no membership price (redacted)", () => {
  const priceless = { ...star, member_price: null } as any;

  render(
    <CreatorSubscribeContent
      showPay={true}
      setShowPay={jest.fn()}
      star={priceless}
    />
  );

  expect(screen.queryByText("SUBSCRIBE")).toBeNull();
  expect(screen.getByText(/has not set a membership price yet/)).toBeTruthy();
  expect(screen.queryByText(/For .* 2Zs per month/)).toBeNull();
  expect(mocked.post).not.toHaveBeenCalled();
});

//0 is a FREE membership, not "no price". The fan sees a free follow
// and can take it even with no 2Z.
it("offers a free follow for a creator whose price is 0", () => {
  const free = { ...star, member_price: "0" } as any;

  render(
    <CreatorSubscribeContent
      showPay={true}
      setShowPay={jest.fn()}
      star={free}
    />
  );

  expect(screen.getByText("FOLLOW — FREE")).toBeTruthy();
  expect(screen.getByText(/Free membership: follow/)).toBeTruthy();
  expect(screen.queryByText(/has not set a membership price yet/)).toBeNull();
});

it("does not delete a retired key it could not durably set aside", async () => {
  // Codex adversarial review, round 6. With localStorage at quota `setItem`
  // throws and the value lands in memory, while `removeItem` still
  // succeeds -- so setting a pre- key aside and then deleting it
  // destroyed the only durable reference to a receipt the fan had already
  // paid for. After the reload the abort copy asks for, no superseded
  // header would be sent and the retry buys a second month.
  localStorage.setItem("f2z:subscribe-idempotency:astar", "f2z-legacy");
  jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("QuotaExceededError");
  });

  const headers = subscribeIdempotencyHeaders("astar", "fan");

  expect(headers["Idempotency-Key"]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
  expect(headers["X-Superseded-Idempotency-Key"]).toBe("f2z-legacy");
  // The last durable reference survived.
  expect(localStorage.getItem("f2z:subscribe-idempotency:astar")).toBe(
    "f2z-legacy"
  );
});

it("still tidies a retired key away when the store accepts the copy", async () => {
  // The veto above must not have become "never move it".
  localStorage.setItem("f2z:subscribe-idempotency:astar", "f2z-legacy");

  const headers = subscribeIdempotencyHeaders("astar", "fan");

  expect(headers["X-Superseded-Idempotency-Key"]).toBe("f2z-legacy");
  expect(
    localStorage.getItem("f2z:subscribe-idempotency-superseded:astar")
  ).toBe("f2z-legacy");
  expect(localStorage.getItem("f2z:subscribe-idempotency:astar")).toBe(
    headers["Idempotency-Key"]
  );
});

it("a nearly-full store cannot overwrite the retired key either", async () => {
  // Codex adversarial review, round 7. Vetoing the DELETE is not enough: a
  // store at quota can refuse a NEW entry (the superseded slot) and still
  // accept REPLACING an existing one of similar size (the main slot), so
  // the freshly minted key overwrote the value the veto had just saved.
  localStorage.setItem("f2z:subscribe-idempotency:astar", "f2z-legacy");
  const real = Storage.prototype.setItem;
  jest
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, name: string, value: string) {
      // Room to replace what is there, none for anything new.
      if (this.getItem(name) === null) {
        throw new DOMException("QuotaExceededError");
      }
      real.call(this, name, value);
    } as typeof Storage.prototype.setItem);

  const first = subscribeIdempotencyHeaders("astar", "fan");
  const second = subscribeIdempotencyHeaders("astar", "fan");

  expect(second["Idempotency-Key"]).toBe(first["Idempotency-Key"]);
  expect(second["X-Superseded-Idempotency-Key"]).toBe("f2z-legacy");
  // The paid receipt's key is still the durable value.
  expect(localStorage.getItem("f2z:subscribe-idempotency:astar")).toBe(
    "f2z-legacy"
  );
});

it("adopts a later legacy UUID after the earlier stable purchase settled", () => {
  const identity = {
    creatorId: 71,
    payerId: 18,
    username: "later-star",
    payerUsername: "later-payer",
  };
  const first = subscribeIdempotencyHeaders(identity)["Idempotency-Key"];
  clearSubscribeIdempotencyKey(identity);
  clearSubscribeIdempotencyKey(identity.username);
  const later = subscribeIdempotencyHeaders(identity.username)[
    "Idempotency-Key"
  ];
  expect(later).not.toBe(first);
  expect(subscribeIdempotencyHeaders(identity)["Idempotency-Key"]).toBe(later);
});

it("membership resolves a paid legacy-only key before another payer purchases", () => {
  const held = subscribeIdempotencyHeaders("astar", "fan")["Idempotency-Key"];
  retireResolvedSubscribeIdempotencyKeys(["astar"], 7, [42], "fan");
  expect(
    subscribeIdempotencyHeaders({
      creatorId: 42,
      payerId: 8,
      username: "astar",
      payerUsername: "other",
    })["Idempotency-Key"]
  ).not.toBe(held);
});

it("old cached auth missing payer id cannot throw or retire payment evidence", () => {
  const held = subscribeIdempotencyHeaders("astar", "fan")["Idempotency-Key"];
  for (const payer of [undefined, null, ""]) {
    expect(() =>
      retireResolvedSubscribeIdempotencyKeys(["astar"], payer, [42], "fan")
    ).not.toThrow();
  }
  expect(localStorage.getItem("f2z:subscribe-idempotency:astar")).toBe(held);
});

it.each([
  "missing payer",
  "renamed payer",
  "foreign immutable owner",
  "creator reused name",
])("membership preserves old intent with %s", (scenario) => {
  const key = subscribeIdempotencyHeaders("astar", "fan")["Idempotency-Key"];
  if (scenario === "missing payer")
    localStorage.removeItem("f2z:subscribe-idempotency-payer:astar");
  const ownerName = `f2z:subscribe-idempotency-adoption-owner:${encodeURIComponent(
    key
  )}`;
  if (
    scenario === "foreign immutable owner" ||
    scenario === "creator reused name"
  ) {
    localStorage.setItem(
      ownerName,
      JSON.stringify({
        payerId: scenario === "foreign immutable owner" ? "8" : "7",
        creatorId: scenario === "creator reused name" ? "99" : "42",
        settled: false,
      })
    );
  }
  const before = JSON.stringify(localStorage);
  retireResolvedSubscribeIdempotencyKeys(
    ["astar"],
    7,
    [42],
    scenario === "renamed payer" ? "renamed" : "fan"
  );
  expect(JSON.stringify(localStorage)).toBe(before);
});

it("keeps the old-tab payment key when a different payer's purchase settled", () => {
  const alice = {
    creatorId: 42,
    payerId: 7,
    username: "astar",
    payerUsername: "alice",
  };
  const bob = { ...alice, payerId: 8, payerUsername: "bob" };
  const first = subscribeIdempotencyHeaders(alice);
  clearSubscribeIdempotencyKey(alice);
  const oldBob = subscribeIdempotencyHeaders("astar", "bob");
  expect(oldBob["Idempotency-Key"]).not.toBe(first["Idempotency-Key"]);
  expect(subscribeIdempotencyHeaders(bob)).toEqual(oldBob);
});

it("does not adopt a settled marker without immutable ownership", () => {
  const key = "11111111-1111-4111-8111-111111111111";
  localStorage.setItem("f2z:subscribe-idempotency:astar", key);
  localStorage.setItem(
    `f2z:subscribe-idempotency-adoption-owner:${key}`,
    JSON.stringify({ settled: true })
  );
  const before = JSON.stringify(localStorage);
  expect(() =>
    subscribeIdempotencyHeaders({
      creatorId: 42,
      payerId: 7,
      username: "astar",
      payerUsername: "fan",
    })
  ).toThrow(SubscriptionIdempotencyStorageError);
  expect(JSON.stringify(localStorage)).toBe(before);
});
