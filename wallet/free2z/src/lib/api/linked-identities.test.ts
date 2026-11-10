// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

async function api() {
  vi.resetModules();
  vi.doMock("../platform", () => ({
    useMock: () => false,
    isTauri: () => false,
  }));
  const [{ auth }, http] = await Promise.all([
    import("./free2z"),
    import("./http"),
  ]);
  return { auth, setToken: http.setToken };
}

const account = (overrides: Record<string, unknown> = {}) => ({
  username: "owner",
  full_name: "Owner",
  tuzis: "0",
  zcash_identity_linked: true,
  social_identities: ["google"],
  ...overrides,
});

it("auth.me hydrates durable link state on each account read", async () => {
  const { auth, setToken } = await api();
  const fetch = vi.fn(
    async () => new Response(JSON.stringify(account()), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetch);
  window.fetch = fetch as typeof window.fetch;
  setToken("owner-token");

  const first = await auth.me();
  const freshClientRead = await auth.me();

  expect(first.zcash_identity_linked).toBe(true);
  expect(first.social_identities).toEqual(["google"]);
  expect(freshClientRead).toEqual(first);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("does not interpret omitted identity fields as an unlinked result", async () => {
  const { auth, setToken } = await api();
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify(
          account({
            zcash_identity_linked: undefined,
            social_identities: undefined,
          }),
        ),
        { status: 200 },
      ),
  );
  vi.stubGlobal("fetch", fetch);
  window.fetch = fetch as typeof window.fetch;
  setToken("owner-token");

  const user = await auth.me();
  expect(user.zcash_identity_linked).toBeUndefined();
  expect(user.social_identities).toBeUndefined();
});

it("Zcash association trusts the refreshed account response, not the submitted key", async () => {
  const { auth, setToken } = await api();
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes("zcash/login"))
      return new Response("{}", { status: 200 });
    return new Response(
      JSON.stringify(account({ zcash_identity_linked: false })),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fetch);
  window.fetch = fetch as typeof window.fetch;
  setToken("owner-token");

  const user = await auth.zcashAssociate({
    address: "t1submitted",
    challenge: "challenge",
    signature: "signature",
  });

  expect(user.zcash_identity_linked).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(user)).not.toContain("t1submitted");
});

it("409 remediation is actionable and does not replace the caller session", async () => {
  const { auth, setToken } = await api();
  const fetch = vi.fn(async () => new Response("conflict", { status: 409 }));
  vi.stubGlobal("fetch", fetch);
  window.fetch = fetch as typeof window.fetch;
  setToken("owner-token");

  await expect(
    auth.zcashAssociate({
      address: "t1conflict",
      challenge: "challenge",
      signature: "signature",
    }),
  ).rejects.toThrow(
    /already linked.*different free2z account.*this account.*unlink.*different key/i,
  );
  expect(window.localStorage.getItem("zuuli.knox.token")).toBe("owner-token");
  expect(fetch).toHaveBeenCalledTimes(1);
});
