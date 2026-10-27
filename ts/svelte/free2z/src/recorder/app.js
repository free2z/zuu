import RealtimeKitClient from "@cloudflare/realtimekit";
import { RealtimeKitRecording } from "@cloudflare/realtimekit-recording-sdk";
import { defineCustomElements } from "@cloudflare/realtimekit-ui/loader";
import { parseRecorderConfig, watermarkOptions } from "./config.js";

// This entry is standalone: no app layout, auth cookies, analytics or reporting
// SDK. Read the provider's short-lived token once, then remove the whole query
// before the SDK, image elements or dynamically loaded UI components run.
const query = new URLSearchParams(location.search);
let authToken = query.get("authToken");
const encodedConfig = query.get("config");
history.replaceState(null, "", location.pathname);
query.delete("authToken");
const status = /** @type {HTMLElement} */ (document.getElementById("status"));
const container = /** @type {HTMLElement} */ (
  document.getElementById("meeting")
);
/** @type {Awaited<ReturnType<typeof RealtimeKitClient.init>> | undefined} */
let meeting;
/** @type {RealtimeKitRecording | undefined} */
let recorder;

async function start() {
  if (!authToken || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(authToken)) {
    throw new Error("Missing recorder token");
  }
  const config = parseRecorderConfig(encodedConfig);
  const watermark = watermarkOptions(config);
  await defineCustomElements(window, {
    resourcesUrl: "__FREE2Z_RECORDER_ASSET_BASE__ui/",
  });
  meeting = await RealtimeKitClient.init({
    authToken,
    defaults: { audio: false, video: false },
  });
  authToken = null;
  // The provider-issued recorder preset controls subscriptions. RtkGrid
  // includes on-stage participants, active speakers, shared screens/plugins;
  // RtkParticipantsAudio mixes the remote participants through the SDK.
  for (const tag of ["rtk-grid", "rtk-participants-audio"]) {
    const element = /** @type {HTMLElement & {meeting?: typeof meeting}} */ (
      document.createElement(tag)
    );
    element.meeting = meeting;
    container.append(element);
  }
  if (watermark) {
    const image = document.createElement("img");
    image.className = "watermark";
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    const [horizontal, vertical] = watermark.position.split(" ");
    image.style.setProperty(horizontal, "0");
    image.style.setProperty(vertical, "0");
    for (const [axis, value] of Object.entries(watermark.size))
      image.style.setProperty(axis, `${value}px`);
    image.src = watermark.url;
    container.append(image);
    await image.decode();
  }
  // Recording SDK 0.0.4 calls meeting.join() itself, before sending the
  // StartRecording command to the container's localhost websocket.
  recorder = new RealtimeKitRecording({
    autoStart: true,
    autoStop: true,
    waitTimeMs: 60000,
  });
  meeting.self.on("roomJoined", () => status.remove());
  await recorder.init(meeting);
}

start().catch(async () => {
  // No exception text or request URL: either may include bearer credentials.
  authToken = null;
  status.textContent = "Unable to initialize recording.";
  try {
    await meeting?.leave();
  } catch {
    /* No token-bearing diagnostics. */
  }
});
window.addEventListener(
  "pagehide",
  () => {
    void recorder?.cleanup().catch(() => {});
    void meeting?.leave().catch(() => {});
  },
  { once: true },
);
