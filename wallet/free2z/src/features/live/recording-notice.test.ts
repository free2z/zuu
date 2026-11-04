import { describe, expect, it } from "vitest";
import { recordingNoticeFor } from "./recording-notice";

describe("recording notice", () => {
  it("stays hidden unless a recording is starting, active, or paused", () => {
    for (const recordingState of ["STARTING", "RECORDING", "PAUSED"]) {
      expect(
        recordingNoticeFor({
          recordingState,
          viewType: "GROUP_CALL",
          stageStatus: "OFF_STAGE",
        })?.state,
      ).toBe(recordingState);
    }
    for (const recordingState of ["IDLE", "STOPPING", "INVOKED", null]) {
      expect(
        recordingNoticeFor({
          recordingState,
          viewType: "WEBINAR",
          stageStatus: "ON_STAGE",
        }),
      ).toBeNull();
    }
  });

  it("emphasizes whoever is on a webinar or livestream stage", () => {
    expect(
      recordingNoticeFor({
        recordingState: "RECORDING",
        viewType: "WEBINAR",
        stageStatus: "ON_STAGE",
      }),
    ).toEqual({ state: "RECORDING", emphasis: "stage", onStage: true });
    expect(
      recordingNoticeFor({
        recordingState: "RECORDING",
        viewType: "LIVESTREAM",
        stageStatus: "OFF_STAGE",
      }),
    ).toEqual({ state: "RECORDING", emphasis: "audience", onStage: false });
  });

  it("treats a room without a stage as fully recorded", () => {
    expect(
      recordingNoticeFor({
        recordingState: "PAUSED",
        viewType: "GROUP_CALL",
        stageStatus: "OFF_STAGE",
      }),
    ).toEqual({ state: "PAUSED", emphasis: "stage", onStage: false });
  });
});
