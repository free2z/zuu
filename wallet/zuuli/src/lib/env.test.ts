import { describe, expect, it } from "vitest";
import {
  free2zRuntimeOrigins,
  parseFree2zArtifactTarget,
} from "./env";

describe("production artifact target parser", () => {
  it.each([
    "zuuli-runtime-target-v2|api=https://free2z.cash|media=https://free2z.cash",
    "zuuli-runtime-target-v1|endpoint=https://free2z.cash|media=https://free2z.cash",
    "zuuli-runtime-target-v1|api=https://free2z.cash|assets=https://free2z.cash",
    "zuuli-runtime-target-v1|api=https://free2z.cash|media=https://free2z.cash|unexpected=true",
  ])("rejects malformed provenance: %s", (target) => {
    expect(() => parseFree2zArtifactTarget(target)).toThrow(
      "ZUULI production runtime target is malformed.",
    );
  });
});

describe("Free2Z runtime origins", () => {
  it("pins both production transports even when the build environment requests staging", () => {
    expect(
      free2zRuntimeOrigins({
        DEV: false,
        VITE_F2Z_API: "https://stage.free2z.cash",
        VITE_F2Z_MEDIA: "https://stage.free2z.cash",
      }),
    ).toEqual({
      api: "https://free2z.cash",
      media: "https://free2z.cash",
    });
  });

  it("treats an absent DEV marker as production instead of accepting overrides", () => {
    expect(
      free2zRuntimeOrigins({
        VITE_F2Z_API: "https://stage.free2z.cash",
        VITE_F2Z_MEDIA: "https://stage.free2z.cash",
      }),
    ).toEqual({
      api: "https://free2z.cash",
      media: "https://free2z.cash",
    });
  });

  it("keeps development proxy defaults and explicit local overrides", () => {
    expect(free2zRuntimeOrigins({ DEV: true })).toEqual({ api: "", media: "" });
    expect(
      free2zRuntimeOrigins({
        DEV: true,
        VITE_F2Z_API: "http://127.0.0.1:8000/",
        VITE_F2Z_MEDIA: "http://127.0.0.1:8001/",
      }),
    ).toEqual({
      api: "http://127.0.0.1:8000",
      media: "http://127.0.0.1:8001",
    });
  });
});
