import { Helmet } from "react-helmet-async";
import {
  useRealtimeKitClient,
  RealtimeKitProvider,
} from "@cloudflare/realtimekit-react";
import axios from "axios";
import RealtimeKitClient from "@cloudflare/realtimekit";
import { useEffect, useRef, useState } from "react";
import type { MeetingJoinRequestSchema } from "../../../svelte/free2z/src/lib/api/f2z.schemas";
import { useParams } from "react-router-dom";
import { useTransitionNavigate } from "./hooks/useTransitionNavigate";
import DyteLeave from "./components/DyteLeave";
import DyteCreator from "./components/DyteCreator";
import SubscribeToCreator from "./components/SubscribeToCreator";
import { PublicCreator } from "./CreatorDetail";
import { getGlobalState, useGlobalState } from "./state/global";
import { useStoreState } from "./state/persist";
import { createHostSeat } from "./hostSeat";

function paidJoinKey(
  owner: string,
  actorId: number,
  sessionId: string,
): string {
  const storageKey = `f2z:ppv-join:${owner.toLowerCase()}:${actorId}:${sessionId}`;
  let existing: string | null;
  try {
    existing = sessionStorage.getItem(storageKey);
  } catch {
    throw new Error("Paid stream retry storage is unavailable.");
  }
  if (existing) return existing;
  // A module cache is not durable across reloads. Never send a paid request
  // until the retry identity can be read back from session storage.
  const key = crypto.randomUUID();
  try {
    sessionStorage.setItem(storageKey, key);
    if (sessionStorage.getItem(storageKey) !== key)
      throw new Error("readback failed");
  } catch {
    throw new Error("Paid stream retry storage is unavailable.");
  }
  return key;
}

export default function CreatorLive() {
  const params = useParams();
  const owner = params.id;
  const type = params.type?.toLowerCase();
  const ppvPrice = useStoreState("ppvPrice");
  const [creator, _c] = useGlobalState("creator");
  const setSnackbarState = useGlobalState("snackbar")[1];
  const [loading, setLoading] = useGlobalState("loading");
  const [loginModal, setLoginModal] = useGlobalState("loginModal");
  const [authStatus, _a] = useGlobalState("authStatus");
  const [authEpoch] = useGlobalState("authEpoch");
  const navigate = useTransitionNavigate();
  const [meeting, initMeeting] = useRealtimeKitClient();
  const [hostMeeting, setHostMeeting] = useState<{ client: RealtimeKitClient; actor: object; run: object; intent: object }>();
  const intentRef = useRef({ owner, type });
  if (intentRef.current.owner !== owner || intentRef.current.type !== type) intentRef.current = { owner, type };
  const viewerRef = useRef({ id: creator.id, username: creator.username, generation: 0 });
  if (viewerRef.current.id !== creator.id || viewerRef.current.username !== creator.username)
    viewerRef.current = { id: creator.id, username: creator.username, generation: viewerRef.current.generation + 1 };
  const hostRun = useRef<{ key: string; run: ReturnType<typeof createHostSeat> }>();
  const hostIntent = useRef<{ intent: object; epoch: number }>();
  const paidIntentRef = useRef<{
    id: number;
    username: string;
    owner: string | undefined;
    type: string | undefined;
    admissionKey?: string;
    sessionId?: string;
    admissionCleanupFailedSessionId?: string;
  }>();
  const [showPay, setShowPay] = useState(false);
  const [star, setStar] = useState({} as PublicCreator);
  const [starOwner, setStarOwner] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setStar({} as PublicCreator);
    axios
      .get(`/api/creator/${owner}/`)
      .then((res) => {
        if (!cancelled) { setStar(res.data); setStarOwner(owner); }
      })
      .catch((res) => {
        setSnackbarState({
          message: `Failed to get creator ${owner}`,
          severity: "error",
          duration: undefined,
          open: true,
        });
      });
    return () => { cancelled = true; };
  }, [owner]);

  useEffect(() => {
    // console.log("CreatorLive useEffect", authStatus, creator.username, owner, type)
    if (authStatus === false) {
      setLoading(false);
      // users can join public broadcasts without logging in
      if (type !== "broadcast") {
        setLoginModal(true);
        return;
      }
    }
    setLoginModal(false);

    if (!star.username || starOwner !== owner) {
      return;
    }

    if (!creator.username && type !== "broadcast") {
      // console.log("no creator return NULL", creator.username, type)
      setLoginModal(true);
      return;
    }

    const is_owner = Number.isSafeInteger(creator.id) && creator.id > 0 && creator.id === star.id;
    const originalPaidIntent =
      paidIntentRef.current?.owner === owner &&
      paidIntentRef.current?.type === type
        ? paidIntentRef.current
        : undefined;
    if (!creator.can_stream && is_owner && !originalPaidIntent) {
      setSnackbarState({
        message: "You need 150 tuzis to go live",
        severity: "warning",
        duration: undefined,
        open: true,
      });
      navigate("/profile");
      return;
    }

    if (!showPay) {
      setSnackbarState({
        message: "Please wait while the meeting initializes",
        severity: "info",
        duration: undefined,
        open: true,
      });
      setLoading(true);
    }

    const paidViewer = type === "ppv" && (!is_owner || !!originalPaidIntent);
    if (is_owner && !paidViewer && type && type !== "private") {
      const actor = viewerRef.current;
      const intent = intentRef.current;
      if (hostIntent.current?.intent === intent && hostIntent.current.epoch !== authEpoch) {
        hostRun.current?.run.close();
        setLoading(false);
        return;
      }
      hostIntent.current = { intent, epoch: authEpoch };
      const key = `${actor.generation}:${actor.id}:${star.id}:${owner}:${type}`;
      if (hostRun.current?.key !== key || hostRun.current.run.closed) {
        hostRun.current?.run.close();
        const runIdentity = {};
        hostRun.current = {
          key,
          run: createHostSeat({
            username: star.username, actorId: actor.id, type, price: String(ppvPrice),
            isCurrent: () => viewerRef.current === actor && getGlobalState("authEpoch") === authEpoch,
            isIntentCurrent: () => intentRef.current === intent,
            initialize: (authToken) => RealtimeKitClient.init({ authToken, defaults: { audio: true, video: true } }),
            onReady: (client) => {
              setHostMeeting({ client: client as RealtimeKitClient, actor, run: runIdentity, intent });
              setLoading(false);
            },
            onClosed: () => setHostMeeting((current) => current?.run === runIdentity ? undefined : current),
            onError: (error: any) => {
              setLoading(false);
              const response = error?.response ?? error;
              const message = response?.data?.code === "already_live_elsewhere"
                ? "Your broadcast is active in another tab or device. Return there or end it before starting here."
                : "Could not start stream. Please try again.";
              setSnackbarState({ message, severity: "error", duration: null, open: true });
            },
            onLost: () => {
              setLoading(false);
              setSnackbarState({ message: "Your broadcast moved to another tab or device.", severity: "warning", duration: null, open: true });
              navigate("/profile");
            },
          }),
        };
      }
      return hostRun.current.run.retain();
    }
    if (
      paidViewer &&
      (!paidIntentRef.current ||
        paidIntentRef.current.owner !== owner ||
        paidIntentRef.current.type !== type)
    )
      paidIntentRef.current = {
        id: creator.id,
        username: creator.username,
        owner,
        type,
      };
    const originalViewer: {
      id: number;
      username: string;
      admissionKey?: string;
      sessionId?: string;
      admissionCleanupFailedSessionId?: string;
    } = paidIntentRef.current || {
      id: creator.id,
      username: creator.username,
    };
    let cancelled = false;
    let unregisterRoomJoined: (() => void) | undefined;
    const instruction: MeetingJoinRequestSchema = {
      role: "viewer",
      ...(paidViewer ? { expected_actor_id: originalViewer.id } : {}),
    };
    let body: MeetingJoinRequestSchema = instruction;
    const join = async () => {
      if (paidViewer) {
        const fresh = await axios.get("/api/auth/user/");
        if (
          !Number.isSafeInteger(originalViewer.id) ||
          originalViewer.id <= 0 ||
          fresh.data.id !== originalViewer.id ||
          fresh.data.username !== originalViewer.username ||
          viewerRef.current.id !== originalViewer.id ||
          viewerRef.current.username !== originalViewer.username ||
          cancelled
        )
          throw new Error("Sign in again before joining this paid stream.");
        if (!owner) throw new Error("This paid stream is unavailable.");
        const { data: liveStatus } = await axios.get(
          `/api/dyte/${owner}/live-status`,
        );
        if (
          cancelled ||
          viewerRef.current.id !== originalViewer.id ||
          viewerRef.current.username !== originalViewer.username
        )
          throw new Error("Sign in again before joining this paid stream.");
        const providerSessionId = liveStatus?.ppv?.session_id;
        if (
          typeof providerSessionId !== "string" ||
          !providerSessionId.trim()
        ) {
          throw new Error("This paid stream is unavailable.");
        }
        const sessionId = providerSessionId.trim();
        // Tie the durable key to the provider session so a later stream cannot
        // inherit an ambiguous admission from an earlier one.
        if (originalViewer.sessionId !== sessionId) {
          originalViewer.sessionId = sessionId;
          originalViewer.admissionKey = undefined;
          originalViewer.admissionCleanupFailedSessionId = undefined;
        }
        if (originalViewer.admissionCleanupFailedSessionId === sessionId)
          throw new Error(
            "Paid stream joined, but retry storage could not be cleared. Clear this stream's session storage before rejoining.",
          );
        originalViewer.admissionKey ??= paidJoinKey(
          owner,
          originalViewer.id,
          sessionId,
        );
        body = {
          ...instruction,
          admission_idempotency_key: originalViewer.admissionKey,
        };
      }
      return axios.post(`/api/dyte/${owner}/${type}`, body);
    };
    join()
      .then((res) => {
        if (
          paidViewer &&
          (cancelled ||
            viewerRef.current.id !== originalViewer.id ||
            viewerRef.current.username !== originalViewer.username)
        )
          return;
        // console.log("INIT MEETING", res)
        initMeeting({
          authToken: res.data.auth_token,
        })
          .then((client) => {
            if (
              paidViewer &&
              (cancelled ||
                viewerRef.current.id !== originalViewer.id ||
                viewerRef.current.username !== originalViewer.username)
            )
              return;
            if (
              paidViewer &&
              owner &&
              originalViewer.sessionId &&
              client?.self
            ) {
              // initMeeting only initializes the SDK client. The admission is
              // complete once this exact client's room reports that it joined.
              const self = client.self;
              const onRoomJoined = () => {
                self.removeListener("roomJoined", onRoomJoined);
                unregisterRoomJoined = undefined;
                if (
                  cancelled ||
                  viewerRef.current.id !== originalViewer.id ||
                  viewerRef.current.username !== originalViewer.username
                )
                  return;
                const key = `f2z:ppv-join:${owner.toLowerCase()}:${
                  originalViewer.id
                }:${originalViewer.sessionId}`;
                try {
                  sessionStorage.removeItem(key);
                  originalViewer.admissionKey = undefined;
                } catch {
                  // This key has already completed an admission. Keep it out
                  // of future joins even though storage could not be cleared.
                  originalViewer.admissionCleanupFailedSessionId =
                    originalViewer.sessionId;
                }
              };
              self.on("roomJoined", onRoomJoined);
              unregisterRoomJoined = () => {
                self.removeListener("roomJoined", onRoomJoined);
              };
            }
            setSnackbarState({
              message: "Thanks for joining",
              severity: "info",
              duration: undefined,
              open: true,
            });
            setLoading(false);
          })
          .catch((err) => {
            // console.error("catch", err)
            window.location.reload();
          });
      })
      .catch((reason) => {
        if (paidViewer && cancelled) return;
        setLoading(false);
        if (
          paidViewer &&
          ((reason instanceof Error &&
            reason.message ===
              "Sign in again before joining this paid stream.") ||
            (reason?.status === 409 && reason?.data?.code === "actor_changed"))
        ) {
          setSnackbarState({
            message: "Sign in again before joining this paid stream.",
            severity: "warning",
            duration: null,
            open: true,
          });
          return;
        }
        if (
          paidViewer &&
          reason instanceof Error &&
          reason.message ===
            "Paid stream joined, but retry storage could not be cleared. Clear this stream's session storage before rejoining."
        ) {
          setSnackbarState({
            message: reason.message,
            severity: "error",
            duration: null,
            open: true,
          });
          return;
        }
        // console.log("FAIL1", reason)
        if (reason?.status === 402) {
          // must be subscribed
          if (type === "subscribers-only") {
            setShowPay(true);
            return;
          }
          if (type === "ppv") {
            setSnackbarState({
              message: `${reason.data}`,
              severity: "warning",
              duration: null,
              open: true,
            });
            navigate(`/${star.username}`);
            return;
          }
        }
        if (reason?.status === 412 || reason?.status === 404) {
          setSnackbarState({
            message: "Creator is not live!",
            severity: "error",
            duration: null,
            open: true,
          });
          navigate(`/${star.username}`);
          return;
        }
      });
    return () => {
      cancelled = true;
      unregisterRoomJoined?.();
      unregisterRoomJoined = undefined;
    };
  }, [creator.id, creator.username, authEpoch, showPay, star.id, star.username, starOwner, owner, type]);

  // console.log(owner)
  if (!star) {
    // console.log("no star")
    return null;
  }
  // console.log("render CreatorLive", showPay, owner)
  // sth with the 100% maybe?
  if (showPay) {
    // console.log("render subscribetocreator")
    setLoading(false);
    return (
      <>
        <SubscribeToCreator
          star={star}
          showPay={showPay}
          setShowPay={setShowPay}
          nav={true}
        />
      </>
    );
  }
  // Only broadcast type allows unauthenticated users to join
  if (!creator.username && type !== "broadcast") {
    return null;
  }

  return (
    <>
      <Helmet>
        <title>{`${star.username}'s Live Stream - Free2Z`}</title>
      </Helmet>
      <RealtimeKitProvider value={hostMeeting?.actor === viewerRef.current && hostMeeting.intent === intentRef.current ? hostMeeting.client : meeting} fallback={<></>}>
        {!hostMeeting && <DyteLeave />}
        <DyteCreator />
      </RealtimeKitProvider>
    </>
  );
}
