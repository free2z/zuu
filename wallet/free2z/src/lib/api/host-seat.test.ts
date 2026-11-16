import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("./http", async (original) => ({
  ...(await original<typeof import("./http")>()),
  request: vi.fn(),
}));
import { ApiError, getTokenSnapshot, request, setToken } from "./http";
import {
  isCurrentHostSeat,
  registerHostSeat,
  releaseHostSeat,
  retainHostSeat,
  type HostSeat,
} from "./host-seat";
import { live } from "./free2z";
const post = vi.mocked(request);
let seats: HostSeat[];
function seat() {
  const value = registerHostSeat("Alice", 41, getTokenSnapshot());
  seats.push(value);
  return value;
}
beforeEach(() => {
  vi.useFakeTimers();
  post.mockReset().mockResolvedValue({});
  setToken("synthetic-A");
  seats = [];
});
afterEach(() => {
  seats.forEach((s) => releaseHostSeat(s, false));
  setToken(null);
  vi.useRealTimers();
});

it("renews beyond the 60-second admission lease and retries a transient outage", async () => {
  post.mockRejectedValueOnce(new TypeError("offline"));
  const value = seat();
  const lost = vi.fn();
  const detach = retainHostSeat(value, lost);
  await vi.advanceTimersByTimeAsync(75_000);
  expect(post).toHaveBeenCalledTimes(6);
  expect(
    post.mock.calls.every(([, options]) => options?.authToken === "synthetic-A")
  ).toBe(true);
  expect(lost).not.toHaveBeenCalled();
  detach();
  await vi.advanceTimersByTimeAsync(0);
  expect(post.mock.lastCall?.[1]?.body).toEqual({
    host_session: value.session,
    action: "release",
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(post).toHaveBeenCalledTimes(7);
  expect(isCurrentHostSeat(value)).toBe(false);
});

it("aborts a hung heartbeat before the next renewal and never overlaps requests", async () => {
  post.mockImplementationOnce(
    (_path, options) =>
      new Promise((_, reject) => {
        options!.signal!.addEventListener("abort", () =>
          reject(new Error("aborted"))
        );
      })
  );
  retainHostSeat(seat(), vi.fn());
  await vi.advanceTimersByTimeAsync(9_999);
  expect(post).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5_001);
  expect(post.mock.calls[0][1]!.signal!.aborted).toBe(true);
  expect(post).toHaveBeenCalledTimes(2);
});

it("preserves the same seat through immediate effect replay, then releases once", async () => {
  const value = seat();
  retainHostSeat(value, vi.fn())();
  const detach = retainHostSeat(value, vi.fn());
  await vi.advanceTimersByTimeAsync(60_000);
  expect(
    post.mock.calls.every(([, o]) => (o?.body as any).action === "heartbeat")
  ).toBe(true);
  detach();
  await vi.advanceTimersByTimeAsync(0);
  expect(
    post.mock.calls.filter(([, o]) => (o?.body as any).action === "release")
  ).toHaveLength(1);
  const stale = vi.fn();
  retainHostSeat({ ...value }, stale);
  expect(stale).toHaveBeenCalledOnce();
});

it("supersession stops renewal and invokes eviction once without releasing another seat", async () => {
  post.mockRejectedValueOnce(
    new ApiError(409, "superseded", { code: "host_session_superseded" })
  );
  const lost = vi.fn();
  retainHostSeat(seat(), lost);
  await vi.advanceTimersByTimeAsync(75_000);
  expect(lost).toHaveBeenCalledOnce();
  expect(post).toHaveBeenCalledTimes(1);
});

it("account changes invalidate callbacks and never send A's release with B's credentials", async () => {
  const value = seat();
  const lost = vi.fn();
  retainHostSeat(value, lost);
  await vi.advanceTimersByTimeAsync(0);
  setToken("synthetic-B");
  setToken("synthetic-A");
  await vi.advanceTimersByTimeAsync(75_000);
  expect(lost).toHaveBeenCalledOnce();
  expect(post).toHaveBeenCalledTimes(1);
  expect(isCurrentHostSeat(value)).toBe(false);
  expect(seat().session).not.toBe(value.session);
});

it.each([0, -1, 1.5, 10_000, NaN, undefined])(
  "rejects invalid PPV rate %s before any request",
  async (rate) => {
    await expect(live.start("ppv", rate)).rejects.toThrow("Invalid PPV price");
    expect(post).not.toHaveBeenCalled();
  }
);

function providerToken() {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  return `${encode({ alg: "RS256" })}.${encode({
    meetingId: "meeting",
    orgId: "org",
    participantId: "host",
    exp: 4102444800,
  })}.signature`;
}
it.each([1, 23, 9999])(
  "forwards canonical rate %s and retains the authoritative seat for each new start",
  async (rate) => {
    post.mockImplementation(async (path, options) =>
      path === "/api/auth/user/"
        ? { id: 41, username: "Alice", tuzis: "100" }
        : {
            host_session: (options?.body as any).host_session,
            auth_token: providerToken(),
            meeting_id: "meeting",
          }
    );
    const first = await live.start("ppv", rate);
    seats.push(first.ticket.hostSeat!);
    const second = await live.start("ppv", rate);
    seats.push(second.ticket.hostSeat!);
    expect(first.ticket.hostSeat!.session).not.toBe(
      second.ticket.hostSeat!.session
    );
    const starts = post.mock.calls.filter(([path]) => path.endsWith("/ppv"));
    expect(starts.map(([, o]) => (o?.body as any).price_per_minute)).toEqual([
      `${rate}.00`,
      `${rate}.00`,
    ]);
    expect(starts.every(([, o]) => o?.authToken === "synthetic-A")).toBe(true);
    expect(
      starts.every(([, o]) => (o?.body as any).expected_actor_id === 41)
    ).toBe(true);
  }
);

it("a late start response from another token generation cannot install ownership", async () => {
  let resolve!: (value: unknown) => void;
  post.mockResolvedValueOnce({ id: 41, username: "Alice", tuzis: "100" });
  post.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const result = live.start("broadcast");
  await vi.advanceTimersByTimeAsync(0);
  const submitted = post.mock.calls[1][1]?.body as { host_session: string };
  setToken("synthetic-B");
  resolve({
    host_session: submitted.host_session,
    auth_token: providerToken(),
    meeting_id: "meeting",
  });
  await expect(result).rejects.toThrow("could not be confirmed");
  expect(post).toHaveBeenCalledTimes(2);
});
