import { useMock } from "@/lib/platform";
import {
  ApiError,
  getTokenSnapshot,
  request,
  type TokenSnapshot,
} from "./http";

export type ReportKind = "comment" | "zpage" | "creator";
export type ReportReason =
  "csae" | "harassment" | "hate" | "sexual" | "violence" | "spam" | "other";
const mockBlocks = new Map<string, Set<string>>();
const mockReports = new Set<string>();

export async function mockBlockedNames(): Promise<string[]> {
  if (!getTokenSnapshot().token) return [];
  const { useSession } = await import("@/store/session");
  const actor = useSession.getState().user?.username?.toLowerCase();
  return actor ? [...(mockBlocks.get(actor) ?? [])] : [];
}

async function mockActor(): Promise<string> {
  const { useSession } = await import("@/store/session");
  const name = useSession.getState().user?.username;
  if (!name) throw new ApiError(401, "Authentication required");
  return name.toLowerCase();
}

function assertSession(snapshot: TokenSnapshot) {
  const now = getTokenSnapshot();
  if (
    !snapshot.token ||
    now.token !== snapshot.token ||
    now.generation !== snapshot.generation
  ) {
    throw new ApiError(401, "Session changed");
  }
}

export const moderation = {
  async list(
    snapshot: TokenSnapshot,
    expectedActor?: string,
  ): Promise<string[]> {
    assertSession(snapshot);
    if (useMock()) {
      const actor = await mockActor();
      assertSession(snapshot);
      if (expectedActor && actor !== expectedActor.toLowerCase())
        throw new ApiError(401, "Session changed");
      return [...(mockBlocks.get(actor) ?? [])];
    }
    const names: string[] = [];
    let page = 1;
    let pages = 1;
    do {
      assertSession(snapshot);
      const response = await request<{
        count: number;
        next: string | null;
        results: { username: string }[];
      }>("/api/g12f/blocks/mine/", {
        authToken: snapshot.token!,
        query: { page, page_size: 48 },
      });
      assertSession(snapshot);
      if (
        !Array.isArray(response.results) ||
        !Number.isSafeInteger(response.count) ||
        response.count < 0 ||
        response.results.some(
          (row) => typeof row?.username !== "string" || !row.username,
        )
      )
        throw new Error("Invalid block list");
      names.push(...response.results.map((row) => row.username));
      pages = Math.max(pages, Math.ceil(response.count / 48));
      if (!response.next) break;
      page += 1;
    } while (page <= pages);
    return names;
  },
  async setBlocked(
    username: string,
    blocked: boolean,
    snapshot: TokenSnapshot,
    expectedActor?: string,
  ): Promise<void> {
    assertSession(snapshot);
    if (useMock()) {
      const actor = await mockActor();
      assertSession(snapshot);
      if (expectedActor && actor !== expectedActor.toLowerCase())
        throw new ApiError(401, "Session changed");
      if (actor === username.toLowerCase())
        throw new ApiError(400, "Cannot block yourself");
      const { mockCreators } = await import("./mock-data");
      assertSession(snapshot);
      if (actor !== (await mockActor()))
        throw new ApiError(401, "Session changed");
      if (
        !mockCreators.some(
          (creator) =>
            creator.username.toLowerCase() === username.toLowerCase(),
        )
      )
        throw new ApiError(404, "Account not found");
      const names = mockBlocks.get(actor) ?? new Set<string>();
      if (blocked) names.add(username.toLowerCase());
      else names.delete(username.toLowerCase());
      mockBlocks.set(actor, names);
      return;
    }
    const response = await request<{ username?: unknown; active?: unknown }>(
      `/api/creator/${encodeURIComponent(username)}/block/`,
      {
        method: blocked ? "PUT" : "DELETE",
        authToken: snapshot.token!,
      },
    );
    assertSession(snapshot);
    if (
      typeof response?.username !== "string" ||
      response.username.toLowerCase() !== username.toLowerCase() ||
      response.active !== blocked
    )
      throw new Error("Invalid block response");
  },
  async report(
    kind: ReportKind,
    targetId: string,
    reason: ReportReason,
    details: string,
    snapshot: TokenSnapshot,
    expectedActor?: string,
  ): Promise<void> {
    assertSession(snapshot);
    if (useMock()) {
      const actor = await mockActor();
      assertSession(snapshot);
      if (expectedActor && actor !== expectedActor.toLowerCase())
        throw new ApiError(401, "Session changed");
      if (!targetId || !reason || details.length > 2000)
        throw new ApiError(400, "Invalid report");
      const { mockArticles, mockCommentExists, mockCreators } =
        await import("./mock-data");
      assertSession(snapshot);
      if (actor !== (await mockActor()))
        throw new ApiError(401, "Session changed");
      const exists =
        kind === "creator"
          ? mockCreators.some((creator) => creator.username === targetId)
          : kind === "zpage"
            ? mockArticles.some((article) => article.free2zaddr === targetId)
            : mockCommentExists(targetId);
      if (!exists) throw new ApiError(404, "Target not found");
      mockReports.add(`${actor}:${kind}:${targetId}:${reason}`);
      return;
    }
    await request("/api/reports/", {
      method: "POST",
      authToken: snapshot.token!,
      body: { target_kind: kind, target_id: targetId, reason, details },
    });
    assertSession(snapshot);
  },
};
