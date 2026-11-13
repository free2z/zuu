import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { mountProducer } from "../../../../../ts/svelte/free2z/src/lib/producer/panel";
import { ProducerFailure } from "../../../../../ts/svelte/free2z/src/lib/producer/client";
import { producerLabelKeys } from "../../../../../ts/svelte/free2z/src/lib/producer/labels";
import {
  request,
  ApiError,
  getTokenSnapshot,
  onTokenChange,
} from "@/lib/api/http";
import { useSession } from "@/store/session";

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
        producerLabelKeys.map((key) => [key, t(`producer.${key}`)]),
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
