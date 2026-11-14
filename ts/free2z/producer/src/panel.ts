/** Accessible producer surface shared by the web dashboard and content app. */
import {
  ProducerClient,
  ProducerFailure,
  type ProducerTransport,
} from "./client";
export type ProducerMeeting = {
  join(): Promise<unknown>;
  leave(): Promise<unknown>;
  audio(on: boolean): Promise<unknown>;
  video(on: boolean): Promise<unknown>;
  device(device: MediaDeviceInfo): Promise<unknown>;
  preview(video: HTMLVideoElement): void;
  onLeft(callback: () => void): () => void;
  media(): { audio: boolean; video: boolean };
  onMedia(callback: () => void): () => void;
};
export type ProducerLabels = Record<string, string>;
export function mountProducer(
  root: HTMLElement,
  options: {
    actor: number;
    transport: ProducerTransport;
    labels: ProducerLabels;
    connect(token: string): Promise<ProducerMeeting>;
    current(): boolean;
  },
) {
  const t = (key: string) => options.labels[key] ?? key;
  let interrupted = false;
  let mediaGeneration = 0;
  let eligible: boolean | null = null;
  let stopped = false,
    busy = false,
    ready = false,
    media: MediaStream | null = null;
  let meeting: ProducerMeeting | null = null,
    unbind = () => {},
    audio = false,
    video = true;
  let devices: MediaDeviceInfo[] = [],
    timer: ReturnType<typeof setTimeout> | undefined,
    presenceTimer: ReturnType<typeof setTimeout> | undefined;
  let storage: Storage | undefined;
  try {
    storage = sessionStorage;
  } catch {
    /* mutation will refuse */
  }
  const client = new ProducerClient(options.actor, options.transport, storage);
  root.classList.add("f2z-producer");
  const style = document.createElement("style");
  style.textContent =
    ".f2z-producer{display:grid;gap:1rem;max-width:48rem}.f2z-producer label{display:grid;gap:.3rem}.f2z-producer button,.f2z-producer input,.f2z-producer select,.f2z-producer textarea{min-height:44px;border:1px solid currentColor;border-radius:.5rem;padding:.5rem;background:transparent;color:inherit}.f2z-producer button:enabled,.f2z-producer select:enabled{cursor:pointer}.f2z-producer button:disabled,.f2z-producer select:disabled{opacity:.5;cursor:default}.f2z-producer video{width:100%;max-height:50vh;background:#111}.f2z-producer :focus-visible{outline:3px solid #827bff;outline-offset:3px}.f2z-producer [role=status],.f2z-producer [role=alert]{white-space:pre-wrap}.f2z-producer .actions{display:flex;flex-wrap:wrap;gap:.5rem}";
  root.append(style);
  const heading = document.createElement("h2");
  heading.textContent = t("heading");
  root.append(heading);
  const intro = document.createElement("p");
  intro.textContent = t("guidance");
  root.append(intro);
  const status = document.createElement("p");
  status.role = "status";
  status.setAttribute("aria-live", "polite");
  root.append(status);
  const error = document.createElement("p");
  error.role = "alert";
  root.append(error);
  const input = (key: string, multiline = false) => {
    const label = document.createElement("label");
    label.append(t(key));
    const field = multiline
      ? document.createElement("textarea")
      : document.createElement("input");
    field.maxLength = multiline ? 2000 : 120;
    label.append(field);
    root.append(label);
    return field;
  };
  const title = input("title"),
    description = input("description", true);
  const audienceLabel = document.createElement("label");
  audienceLabel.append(t("audience"));
  const audience = document.createElement("select");
  audience.setAttribute("aria-label", t("audience"));
  for (const key of ["public", "private", "subscribers"]) {
    const o = document.createElement("option");
    o.value = key;
    o.textContent = t(key);
    audience.append(o);
  }
  audienceLabel.append(audience);
  root.append(audienceLabel);
  const paidLabel = document.createElement("label");
  paidLabel.append(t("access"));
  const access = document.createElement("select");
  access.setAttribute("aria-label", t("access"));
  for (const key of ["free", "paid"]) {
    const o = document.createElement("option");
    o.value = key;
    o.textContent = t(key);
    access.append(o);
  }
  paidLabel.append(access);
  root.append(paidLabel);
  const preview = document.createElement("video");
  preview.autoplay = true;
  preview.muted = true;
  preview.playsInline = true;
  preview.setAttribute("aria-label", t("preview"));
  root.append(preview);
  const controls = document.createElement("div");
  controls.className = "actions";
  root.append(controls);
  const buttons: Record<string, HTMLButtonElement> = {};
  function button(
    key: string,
    action: (generation: number) => Promise<unknown>,
  ) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = t(key);
    b.onclick = () => {
      void run(action);
    };
    controls.append(b);
    buttons[key] = b;
    return b;
  }
  function releaseCapture() {
    media?.getTracks().forEach((track) => track.stop());
    media = null;
    preview.srcObject = null;
  }
  async function leave() {
    unbind();
    unbind = () => {};
    const old = meeting;
    meeting = null;
    releaseCapture();
    if (old) await old.leave();
  }
  function cancelMedia() {
    // Invalidate synchronously, before any pending capture/SDK promise settles.
    mediaGeneration++;
    return leave();
  }
  function mediaCurrent(generation: number) {
    if (stopped) return false;
    if (!options.current()) {
      dispose();
      return false;
    }
    if (generation !== mediaGeneration) return false;
    if (document.visibilityState === "hidden" || !navigator.onLine) {
      interrupt();
      return false;
    }
    return true;
  }
  function requireMedia(generation: number, expected?: ProducerMeeting) {
    if (!mediaCurrent(generation) || (expected && meeting !== expected))
      throw new ProducerFailure("media_interrupted");
  }
  async function retire(captured: ProducerMeeting) {
    if (meeting === captured) {
      unbind();
      unbind = () => {};
      meeting = null;
    }
    // A pending join/enable can finish AFTER an earlier leave. Retire the
    // captured instance again even when cancellation cleared the global slot.
    try {
      await captured.leave();
    } finally {
      if (!meeting) preview.srcObject = null;
    }
  }
  async function changeMeeting(
    captured: ProducerMeeting,
    generation: number,
    change: () => Promise<unknown>,
  ) {
    try {
      requireMedia(generation, captured);
      await change();
      requireMedia(generation, captured);
      syncMedia();
    } catch (e) {
      interrupted = true;
      await retire(captured).catch(() => {});
      throw e;
    }
  }
  function render() {
    if (stopped) return;
    const s = client.stream;
    // A snapshot can arrive between heartbeat ticks. Expire its indication at
    // its own deadline, even while the next HTTP request remains in flight.
    clearTimeout(presenceTimer);
    if (s?.state === "live" && client.fresh)
      presenceTimer = setTimeout(render, Math.ceil(client.freshFor));
    const presence =
      navigator.onLine && client.fresh && s?.participants !== null;
    status.textContent =
      `${!navigator.onLine ? t("offline") : eligible === false ? t("creatorIneligible") : ready ? t("backendReady") : t("backendUnavailable")}\n${s ? (s.state === "live" && !presence ? t("unknown") : t(s.state)) : t("noStream")}` +
      `\n${t("participants")}: ${s?.state === "live" && presence ? s.participants : t("unknown")}`;
    const mutable =
      !s ||
      s.state === "cleaned_up" ||
      (s.state === "draft" && s.owner === client.owner);
    if (s && !mutable) {
      title.value = s.title;
      description.value = s.description;
      audience.value = s.audience;
      access.value = s.access;
    }
    title.disabled =
      description.disabled =
      audience.disabled =
      access.disabled =
        busy || !mutable;
    for (const b of Object.values(buttons)) b.disabled = busy;
    for (const [, select] of selectors)
      select.disabled = busy || (!media && !meeting);
    buttons.prepare.disabled ||=
      !ready ||
      !navigator.onLine ||
      !media ||
      !title.value.trim() ||
      !mutable ||
      audience.value !== "public" ||
      access.value !== "free";
    buttons.publish.disabled ||=
      !meeting || !s || !["ready", "interrupted"].includes(s.state);
    buttons.end.disabled ||= !s || s.state === "cleaned_up";
    buttons.reconnect.disabled ||=
      !s ||
      (!["ready", "interrupted"].includes(s.state) &&
        !(s.state === "live" && !meeting)) ||
      s.owner !== client.owner;
    buttons.takeover.disabled ||=
      !s ||
      !["ready", "live", "interrupted"].includes(s.state) ||
      s.owner === client.owner;
    buttons.retry.disabled ||= !client.uncertain;
    buttons.capture.disabled ||= !!meeting;
    buttons.camera.disabled ||= !media && !meeting;
    buttons.microphone.disabled ||= !media && !meeting;
    buttons.camera.setAttribute("aria-pressed", String(video));
    buttons.microphone.setAttribute("aria-pressed", String(audio));
    if (audience.value !== "public" || access.value !== "free")
      error.textContent = t("accessUnavailable");
  }
  async function run(action: (generation: number) => Promise<unknown>) {
    if (busy || stopped) return;
    if (!options.current()) {
      dispose();
      return;
    }
    busy = true;
    error.textContent = "";
    render();
    try {
      await action(mediaGeneration);
    } catch (e) {
      if (stopped) return;
      if (meeting) {
        interrupted = true;
        await cancelMedia().catch(() => {});
      }
      const code =
        e instanceof ProducerFailure ? e.code : (e as { name?: string })?.name;
      error.textContent = t(
        code === "NotAllowedError"
          ? "permissionDenied"
          : code === "NotFoundError" || code === "NotReadableError"
            ? "noDevice"
            : code === "unsupported"
              ? "unsupportedMedia"
              : code === "creator_ineligible"
                ? "creatorIneligible"
                : code === "authentication_required" ||
                    code === "permission_denied" ||
                    code === "actor_changed" ||
                    code === "actor_authentication_changed"
                  ? "authChanged"
                  : "recovery",
      );
    } finally {
      if (!stopped && !options.current()) dispose();
      busy = false;
      render();
      if (
        interrupted &&
        !stopped &&
        !client.uncertain &&
        client.stream &&
        ["ready", "live"].includes(client.stream.state)
      ) {
        interrupted = false;
        void run(async () => {
          await client.command("interrupt");
          await leave();
        });
      }
    }
  }
  button("check", async () => {
    const value = (await options.transport("GET", "/api/dyte/producer/v1")) as {
      ready?: boolean;
      eligible?: boolean;
    };
    eligible =
      value.eligible === true ? true : value.eligible === false ? false : null;
    ready = value.ready === true && eligible === true;
    await client.load();
    if (client.stream) {
      title.value = client.stream.title;
      description.value = client.stream.description;
    }
  });
  button("capture", async (generation) => {
    requireMedia(generation);
    if (!navigator.mediaDevices?.getUserMedia)
      throw new ProducerFailure("unsupported");
    releaseCapture();
    const captured = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: true,
    });
    if (!mediaCurrent(generation)) {
      captured.getTracks().forEach((track) => track.stop());
      return;
    }
    media = captured;
    media.getAudioTracks().forEach((track) => (track.enabled = audio));
    media.getVideoTracks().forEach((track) => (track.enabled = video));
    media
      .getTracks()
      .forEach((track) => track.addEventListener("ended", interrupt));
    preview.srcObject = media;
    const available = await navigator.mediaDevices.enumerateDevices();
    if (!mediaCurrent(generation) || media !== captured) {
      captured.getTracks().forEach((track) => track.stop());
      return;
    }
    devices = available;
    fillDevices();
  });
  button("camera", async (generation) => {
    requireMedia(generation);
    const next = !video;
    const captured = meeting;
    if (captured)
      await changeMeeting(captured, generation, () => captured.video(next));
    else {
      media?.getVideoTracks().forEach((track) => (track.enabled = next));
      video = next;
    }
  });
  button("microphone", async (generation) => {
    requireMedia(generation);
    const next = !audio;
    const captured = meeting;
    if (captured)
      await changeMeeting(captured, generation, () => captured.audio(next));
    else {
      media?.getAudioTracks().forEach((track) => (track.enabled = next));
      audio = next;
    }
  });
  const selectors: Array<[MediaDeviceKind, HTMLSelectElement]> = [];
  for (const kind of ["videoinput", "audioinput"] as const) {
    const label = document.createElement("label");
    label.append(t(kind));
    const select = document.createElement("select");
    select.setAttribute("aria-label", t(kind));
    label.append(select);
    root.append(label);
    selectors.push([kind, select]);
    select.onchange = () => {
      void run(async (generation) => {
        requireMedia(generation);
        const device = devices.find(
          (d) => d.deviceId === select.value && d.kind === kind,
        );
        if (!device) throw new ProducerFailure("no_device");
        const capturedMeeting = meeting;
        if (capturedMeeting)
          await changeMeeting(capturedMeeting, generation, () =>
            capturedMeeting.device(device),
          );
        else {
          const captured = media;
          const replacement = await navigator.mediaDevices.getUserMedia(
            kind === "videoinput"
              ? { video: { deviceId: { exact: device.deviceId } } }
              : { audio: { deviceId: { exact: device.deviceId } } },
          );
          if (!mediaCurrent(generation) || !captured || media !== captured) {
            replacement.getTracks().forEach((t) => t.stop());
            return;
          }
          const newTrack = replacement
            .getTracks()
            .find(
              (track) =>
                track.kind === (kind === "videoinput" ? "video" : "audio"),
            );
          if (!newTrack) {
            replacement.getTracks().forEach((t) => t.stop());
            throw new ProducerFailure("no_device");
          }
          replacement
            .getTracks()
            .filter((track) => track !== newTrack)
            .forEach((track) => track.stop());
          for (const track of media
            .getTracks()
            .filter((t) => t.kind === newTrack.kind)) {
            media.removeTrack(track);
            track.stop();
          }
          newTrack.enabled = newTrack.kind === "video" ? video : audio;
          newTrack.addEventListener("ended", interrupt);
          media.addTrack(newTrack);
          preview.srcObject = media;
        }
      });
    };
  }
  function syncMedia() {
    if (stopped || !meeting) return;
    const state = meeting.media();
    audio = state.audio;
    video = state.video;
    render();
  }
  function fillDevices() {
    for (const [kind, select] of selectors) {
      select.replaceChildren();
      for (const d of devices.filter((d) => d.kind === kind)) {
        const o = document.createElement("option");
        o.value = d.deviceId;
        o.textContent = d.label || t(kind);
        select.append(o);
      }
    }
  }
  async function connect(token: string | null, generation: number) {
    if (!token) throw new ProducerFailure("ticket_expired");
    requireMedia(generation);
    // Only a current, explicitly requested connection resumes media intent.
    interrupted = false;
    let next: ProducerMeeting | undefined;
    let detach = () => {};
    try {
      await leave();
      requireMedia(generation);
      next = await options.connect(token);
      requireMedia(generation);
      meeting = next;
      await next.join();
      requireMedia(generation, next);
      if (!devices.length) {
        const available = await navigator.mediaDevices.enumerateDevices();
        requireMedia(generation, next);
        devices = available;
        fillDevices();
      }
      for (const [, select] of selectors) {
        const d = devices.find((d) => d.deviceId === select.value);
        if (d) {
          await next.device(d);
          requireMedia(generation, next);
        }
      }
      await next.audio(audio);
      requireMedia(generation, next);
      await next.video(video);
      requireMedia(generation, next);
      const captured = next;
      const offLeft = next.onLeft(() => {
        if (meeting === captured) interrupt();
      });
      detach = offLeft;
      const offMedia = next.onMedia(() => {
        if (mediaCurrent(generation) && meeting === captured) syncMedia();
      });
      detach = () => {
        offLeft();
        offMedia();
      };
      requireMedia(generation, next);
      unbind = detach;
      next.preview(preview);
      requireMedia(generation, next);
      syncMedia();
    } catch (e) {
      interrupted = true;
      detach();
      if (next) await retire(next).catch(() => {});
      throw e;
    }
  }
  button("prepare", async (generation) => {
    requireMedia(generation);
    const metadata = {
      title: title.value,
      description: description.value,
      audience: audience.value,
      access: access.value,
    };
    if (client.stream?.state === "draft") {
      await client.command("update", metadata);
    } else {
      await client.command("draft", metadata);
    }
    requireMedia(generation);
    await client.command("provision");
    requireMedia(generation);
    await connect((await client.command("refresh")).token, generation);
  });
  button("publish", async () => {
    await client.command("publish");
  });
  button("reconnect", async (generation) => {
    requireMedia(generation);
    await connect((await client.command("refresh")).token, generation);
  });
  button("takeover", async (generation) => {
    requireMedia(generation);
    await connect((await client.command("takeover")).token, generation);
  });
  button("end", async () => {
    await client.command("end");
    await cancelMedia();
  });
  button("retry", async (generation) => {
    const result = await client.retry();
    if (result.token) await connect(result.token, generation);
  });
  function interrupt() {
    interrupted = true;
    void cancelMedia().catch(() => {});
    render();
    if (
      stopped ||
      !client.stream ||
      client.stream.owner !== client.owner ||
      !["ready", "live"].includes(client.stream.state)
    )
      return;
    // Client termination is only best effort. Server heartbeat expiry is the
    // durable fallback. Never issue end from unload, leave, or background.
    void run(async () => {
      await client.command("interrupt");
      await leave();
    });
  }
  const visibility = () => {
    if (document.visibilityState === "hidden") interrupt();
    else render();
  };
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("online", render);
  window.addEventListener("pagehide", interrupt);
  window.addEventListener("offline", interrupt);
  title.oninput = render;
  audience.onchange = () => {
    error.textContent = "";
    render();
  };
  access.onchange = () => {
    error.textContent = "";
    render();
  };
  const tick = async () => {
    if (stopped) return;
    if (!options.current()) {
      dispose();
      return;
    }
    // Keep expiry rendering independent of a slow in-flight HTTP operation.
    // busy still permits only one request sequence at a time.
    timer = setTimeout(() => void tick(), 15_000);
    if (
      !busy &&
      !client.uncertain &&
      client.stream &&
      !["draft", "cleaned_up"].includes(client.stream.state) &&
      document.visibilityState !== "hidden"
    ) {
      await run(async () => {
        await client.load();
        if (
          client.stream?.owner !== client.owner ||
          !["ready", "live", "interrupted"].includes(client.stream?.state ?? "")
        ) {
          if (meeting) await cancelMedia();
          return;
        }
        await client.command("heartbeat");
        if (meeting && client.stream?.state === "live")
          await client.command("publish");
        await client.load();
        if (
          client.stream?.owner !== client.owner ||
          !["ready", "live", "interrupted"].includes(client.stream?.state ?? "")
        )
          await cancelMedia();
      });
    }
    render();
  };
  function dispose() {
    if (stopped) return;
    stopped = true;
    client.dispose();
    clearTimeout(timer);
    clearTimeout(presenceTimer);
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("online", render);
    window.removeEventListener("pagehide", interrupt);
    window.removeEventListener("offline", interrupt);
    void cancelMedia().catch(() => {});
    root.replaceChildren();
  }
  render();
  void run(async () => {
    const r = (await options.transport("GET", "/api/dyte/producer/v1")) as {
      ready?: boolean;
      eligible?: boolean;
    };
    eligible = r.eligible === true ? true : r.eligible === false ? false : null;
    ready = r.ready === true && eligible === true;
    await client.load();
    if (client.stream) {
      title.value = client.stream.title;
      description.value = client.stream.description;
    }
  });
  timer = setTimeout(() => void tick(), 15_000);
  return dispose;
}
