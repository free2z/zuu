import { expect, type APIRequestContext, type Browser } from "@playwright/test";
import { browserMockApiOrigin } from "./ports";

export const MOCK_API_ORIGIN = browserMockApiOrigin();
export const CONVERSE_ROOT = "2d9c5e30-3333-4444-8555-b66677778888";
export const GATED_THREAD = "1c8b4d2f-2222-4333-8444-a55566667777";

export const PUBLIC = "Public card title";
export const MEMBERS = "Members card title";
export const DRAFT = "Draft card title";
export const THREAD = "Members thread headline";
export const GATED_TEXT = [
  MEMBERS,
  "MEMBERS-ONLY-BODY",
  DRAFT,
  "DRAFT-ONLY-BODY",
  THREAD,
  "MEMBERS-THREAD-BODY",
];

export type Upstream = { path: string; cookie: string | null };

async function upstream(request: APIRequestContext): Promise<Upstream[]> {
  return (await request.get(`${MOCK_API_ORIGIN}/__requests`)).json();
}

const CARD_TARGET =
  /^\/api\/(zpage\/fp-card-(public|subonly|draft|shared|fan-\d+)\/|comments\/1c8b4d2f-2222-4333-8444-a55566667777\/)/;

export async function cardCalls(request: APIRequestContext) {
  return (await upstream(request)).filter((call) =>
    CARD_TARGET.test(call.path),
  );
}

export async function readerPage(
  browser: Browser,
  session: string | null,
  javaScriptEnabled = true,
) {
  const context = await browser.newContext({ javaScriptEnabled });
  if (session) {
    await context.addCookies([
      { name: "sessionid", value: session, domain: "127.0.0.1", path: "/" },
    ]);
  }
  return { context, page: await context.newPage() };
}

export const READERS = [
  { reader: "anonymous", session: null, visible: [PUBLIC] },
  { reader: "stranger", session: "fp-card-stranger", visible: [PUBLIC] },
  {
    reader: "subscriber",
    session: "fp-card-subscriber",
    visible: [PUBLIC, MEMBERS, THREAD],
  },
  {
    reader: "owner",
    session: "fp-card-owner",
    visible: [PUBLIC, MEMBERS, DRAFT, THREAD],
  },
] as const;

export function forbiddenFor(visible: readonly string[]) {
  const bodies: Record<string, string> = {
    [MEMBERS]: "MEMBERS-ONLY-BODY",
    [DRAFT]: "DRAFT-ONLY-BODY",
    [THREAD]: "MEMBERS-THREAD-BODY",
  };
  return GATED_TEXT.filter(
    (text) =>
      !visible.includes(text) &&
      !visible.some((title) => bodies[title] === text),
  );
}

export async function expectCookies(
  calls: Upstream[],
  session: string | null,
): Promise<void> {
  for (const call of calls) {
    if (session) expect(call.cookie ?? "").toContain(`sessionid=${session}`);
    else expect(call.cookie ?? "").not.toContain("sessionid=");
  }
}
