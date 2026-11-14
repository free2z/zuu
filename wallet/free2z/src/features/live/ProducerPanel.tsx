import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  mountProducer,
  ProducerFailure,
  producerLabelKeys,
} from "@free2z/producer";
import { MESSAGE_KEYS } from "@/i18n/messages";
import {
  request,
  ApiError,
  getTokenSnapshot,
  onTokenChange,
} from "@/lib/api/http";
import { useSession } from "@/store/session";

// Bind the shared panel's complete label contract to this app's catalog.
// Each entry is used by the translator below and must match its exact label.
const producerMessages = {
  creatorIneligible: MESSAGE_KEYS.producerCreatorIneligible,
  unsupportedMedia: MESSAGE_KEYS.producerUnsupportedMedia,
  offline: MESSAGE_KEYS.producerOffline,
  heading: MESSAGE_KEYS.producerHeading,
  guidance: MESSAGE_KEYS.producerGuidance,
  title: MESSAGE_KEYS.producerTitle,
  description: MESSAGE_KEYS.producerDescription,
  audience: MESSAGE_KEYS.producerAudience,
  access: MESSAGE_KEYS.producerAccess,
  public: MESSAGE_KEYS.producerPublic,
  private: MESSAGE_KEYS.producerPrivate,
  subscribers: MESSAGE_KEYS.producerSubscribers,
  free: MESSAGE_KEYS.producerFree,
  paid: MESSAGE_KEYS.producerPaid,
  preview: MESSAGE_KEYS.producerPreview,
  backendReady: MESSAGE_KEYS.producerBackendReady,
  backendUnavailable: MESSAGE_KEYS.producerBackendUnavailable,
  noStream: MESSAGE_KEYS.producerNoStream,
  participants: MESSAGE_KEYS.producerParticipants,
  unknown: MESSAGE_KEYS.producerUnknown,
  check: MESSAGE_KEYS.producerCheck,
  capture: MESSAGE_KEYS.producerCapture,
  camera: MESSAGE_KEYS.producerCamera,
  microphone: MESSAGE_KEYS.producerMicrophone,
  videoinput: MESSAGE_KEYS.producerVideoinput,
  audioinput: MESSAGE_KEYS.producerAudioinput,
  prepare: MESSAGE_KEYS.producerPrepare,
  publish: MESSAGE_KEYS.producerPublish,
  reconnect: MESSAGE_KEYS.producerReconnect,
  takeover: MESSAGE_KEYS.producerTakeover,
  end: MESSAGE_KEYS.producerEnd,
  retry: MESSAGE_KEYS.producerRetry,
  accessUnavailable: MESSAGE_KEYS.producerAccessUnavailable,
  permissionDenied: MESSAGE_KEYS.producerPermissionDenied,
  noDevice: MESSAGE_KEYS.producerNoDevice,
  authChanged: MESSAGE_KEYS.producerAuthChanged,
  recovery: MESSAGE_KEYS.producerRecovery,
  draft: MESSAGE_KEYS.producerDraft,
  provisioning: MESSAGE_KEYS.producerProvisioning,
  ready: MESSAGE_KEYS.producerReady,
  live: MESSAGE_KEYS.producerLive,
  interrupted: MESSAGE_KEYS.producerInterrupted,
  ending: MESSAGE_KEYS.producerEnding,
  ended: MESSAGE_KEYS.producerEnded,
  failed: MESSAGE_KEYS.producerFailed,
  cleaned_up: MESSAGE_KEYS.producerCleaned_up,
} satisfies { [Key in (typeof producerLabelKeys)[number]]: `producer.${Key}` };

export function ProducerPanel() {
  const root = useRef<HTMLDivElement>(null);
  const user = useSession((s) => s.user);

  const { t, i18n } = useTranslation();
  useEffect(() => {
    if (!root.current || !user?.id) return;
    const actor = user.id;
    const original = getTokenSnapshot();
    const stop = mountProducer(root.current, {
      actor,
      labels: Object.fromEntries(
        producerLabelKeys.map((key) => [key, t(producerMessages[key])]),
      ),
      current: () =>
        useSession.getState().user?.id === actor &&
        getTokenSnapshot().generation === original.generation,
      transport: async (method, path, body) => {
        try {
          return await request(path, {
            method,
            body,
            cache: "no-store",
            signal: AbortSignal.timeout(45000),
          });
        } catch (e) {
          if (e instanceof ApiError)
            throw new ProducerFailure(
              (e.body as { code?: string })?.code ?? "request_refused",
              e.body,
            );
          throw e;
        }
      },
      connect: async (authToken) => {
        const { default: RealtimeKitClient } =
          await import("@cloudflare/realtimekit");
        const m = await RealtimeKitClient.init({
          authToken,
          defaults: { audio: false, video: false },
        });
        return {
          join: () => m.join(),
          leave: () => m.leave(),
          audio: (on) => (on ? m.self.enableAudio() : m.self.disableAudio()),
          video: (on) => (on ? m.self.enableVideo() : m.self.disableVideo()),
          device: (d) => m.self.setDevice(d),
          preview: (el) => m.self.registerVideoElement(el),
          media: () => ({
            audio: m.self.audioEnabled,
            video: m.self.videoEnabled,
          }),
          onMedia: (callback) => {
            m.self.on("audioUpdate", callback);
            m.self.on("videoUpdate", callback);
            return () => {
              m.self.off("audioUpdate", callback);
              m.self.off("videoUpdate", callback);
            };
          },
          onLeft: (callback) => {
            m.self.on("roomLeft", callback);
            return () => m.self.off("roomLeft", callback);
          },
        };
      },
    });
    const unsubscribe = onTokenChange(() => stop());
    return () => {
      unsubscribe();
      stop();
    };
  }, [user?.id, i18n.resolvedLanguage, t]);
  return <div ref={root} />;
}
