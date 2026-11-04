export type StreamVideoQuality = "1080p" | "720p" | "480p" | "360p";

/** Media constraints supported by @cloudflare/realtimekit 2.0.3. */
export function getStreamVideoConstraints(quality: string) {
  const resolution = (() => {
    switch (quality as StreamVideoQuality) {
      case "1080p":
        return { height: 1080, width: 1920 };
      case "720p":
        return { height: 720, width: 1280 };
      case "480p":
        return { height: 480, width: 854 };
      case "360p":
        return { height: 360, width: 640 };
      default:
        return { height: 720, width: 1280 };
    }
  })();

  return {
    height: { ideal: resolution.height },
    width: { ideal: resolution.width },
    frameRate: { ideal: 24 },
  };
}

/** Camera and screen-share caps understood by the pinned Web SDK (2.0.3). */
export function getHostStreamMediaOptions(quality: string) {
  return {
    defaults: {
      audio: true,
      video: true,
      mediaConfiguration: {
        video: getStreamVideoConstraints(quality),
        screenshare: {
          width: { max: 1280 },
          height: { max: 720 },
          frameRate: { ideal: 5, max: 15 },
        },
      },
    },
    overrides: {
      simulcastConfig: {
        encodings: [
          { rid: "f", maxBitrate: 1_200_000, maxFramerate: 24 },
          {
            rid: "h",
            maxBitrate: 400_000,
            maxFramerate: 24,
            scaleResolutionDownBy: 2,
          },
          {
            rid: "q",
            maxBitrate: 150_000,
            maxFramerate: 24,
            scaleResolutionDownBy: 4,
          },
        ],
      },
    },
  };
}
