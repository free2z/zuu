import { describe, expect, it } from "vitest";
import { ApiError } from "./api/http";
import {
  beginRemoteLoad,
  currentResourceData,
  initialRemoteData,
  isConfirmedNotFound,
  remoteFailure,
  remoteSuccess,
  remoteView,
  type KeyedRemoteData,
  type RemoteDataState,
} from "./remote-data";

const listView = <T>(state: RemoteDataState<T[]>) =>
  remoteView(state, (items) => items.length === 0);

describe("truthful remote-data states", () => {
  it.each([
    "Home LiveRail",
    "Home ArticlesGrid",
    "Home CreatorsRow",
    "Live Discovery",
    "creator pages",
  ])("keeps %s loading, failure, and confirmed empty distinct", () => {
    const initial = initialRemoteData<string[]>();
    expect(listView(initial)).toBe("loading");

    const failed = remoteFailure(initial, new Error("offline"));
    expect(listView(failed)).toBe("error");
    expect(failed.data).toBeNull();

    const retrying = beginRemoteLoad(failed);
    expect(listView(retrying)).toBe("error");
    expect(retrying.loading).toBe(true);
    expect(retrying.error).toBe(failed.error);

    const confirmedEmpty = remoteSuccess<string[]>([]);
    expect(listView(confirmedEmpty)).toBe("empty");
  });

  it("normalizes non-Error rejections so a failure cannot become falsy", () => {
    const failed = remoteFailure(initialRemoteData<string[]>(), null);
    expect(failed.error).toBeInstanceOf(Error);
    expect(listView(failed)).toBe("error");
  });

  it("clears another resource's data and error when the dependency key changes", () => {
    const aliceFailure = remoteFailure(
      remoteSuccess(["alice result"]),
      new ApiError(404, "alice not found"),
    );

    expect(beginRemoteLoad(aliceFailure, { retainData: false })).toEqual({
      data: null,
      loading: true,
      error: null,
    });
  });

  it.each([
    "wallet Overview recent activity",
    "wallet History",
    "2Z Activity",
  ])("retains %s last-known-good data across failure and retry", () => {
    const successful = remoteSuccess(["confirmed transaction"]);
    const refreshing = beginRemoteLoad(successful);
    expect(listView(refreshing)).toBe("refreshing");

    const failed = remoteFailure(refreshing, new Error("timeout"));
    expect(listView(failed)).toBe("stale-error");
    expect(failed.data).toEqual(["confirmed transaction"]);

    const retrying = beginRemoteLoad(failed);
    expect(listView(retrying)).toBe("stale-error");
    expect(retrying.data).toEqual(["confirmed transaction"]);
    expect(retrying.loading).toBe(true);
    expect(retrying.error).toBe(failed.error);

    const confirmedEmpty = remoteSuccess<string[]>([]);
    expect(listView(confirmedEmpty)).toBe("empty");
    const emptyRefreshFailure = remoteFailure(
      beginRemoteLoad(confirmedEmpty),
      new Error("timeout"),
    );
    expect(listView(emptyRefreshFailure)).toBe("stale-error");
    expect(emptyRefreshFailure.data).toEqual([]);
  });

  it.each(["Article Reader", "Creator profile"])(
    "routes only a confirmed 404 to %s not-found",
    () => {
      expect(isConfirmedNotFound(new ApiError(404, "Not found"))).toBe(true);
      expect(isConfirmedNotFound(new ApiError(500, "Server error"))).toBe(
        false,
      );
      expect(isConfirmedNotFound(new TypeError("Network error"))).toBe(false);
    },
  );

  it("keeps Search corpora independent and retries only the failed sibling", () => {
    const creatorSuccess = remoteSuccess(["alice"]);
    const pageFailure = remoteFailure(
      initialRemoteData<string[]>(),
      new Error("page search unavailable"),
    );

    expect(listView(creatorSuccess)).toBe("ready");
    expect(listView(pageFailure)).toBe("error");

    const pageRetry = beginRemoteLoad(pageFailure);
    expect(listView(pageRetry)).toBe("error");
    expect(pageRetry.loading).toBe(true);
    expect(pageRetry.error).toBe(pageFailure.error);
    expect(creatorSuccess.data).toEqual(["alice"]);
    expect(creatorSuccess.loading).toBe(false);
    expect(creatorSuccess.error).toBeNull();
  });

  it("never presents retained data from another resource or search key", () => {
    const alice: KeyedRemoteData<string, string[]> = {
      key: "alice",
      value: ["alice result"],
    };

    expect(currentResourceData(alice, "alice")).toEqual(["alice result"]);
    expect(currentResourceData(alice, "bob")).toBeNull();
  });
});
