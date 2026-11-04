import axios from "axios";
import { useTransitionNavigate } from "../hooks/useTransitionNavigate";

import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  useMediaQuery,
} from "@mui/material";
import { PublicCreator } from "../CreatorDetail";
import { useGlobalState } from "../state/global";
import Tuzis from "./TuzisButton";
import LoginMessageStack from "./LoginMessageStack";
import { useLocation } from "react-router";
import { ReactNode, useEffect, useRef, useState } from "react";
import {
  clearSubscribeIdempotencyKey,
  markSubscribeIdempotencyAbandoned,
  subscribeRecoveryKeys,
  subscribeIdempotencyHeaders,
} from "../subscribeIdempotency";

type SubscribeToCreatorProps = {
  showPay: boolean;
  setShowPay: React.Dispatch<React.SetStateAction<boolean>>;
  // username: string,
  star: PublicCreator;
  nav?: boolean;
  memberPage?: string;
  onCloseClick?: () => void;
};

export const CreatorSubscribeContent = (props: SubscribeToCreatorProps) => {
  const { showPay, setShowPay, star } = props;
  const [fan, setFan] = useGlobalState("creator");
  const setSnackbar = useGlobalState("snackbar")[1];

  const navigate = useTransitionNavigate();
  const location = useLocation();

  const isXS = useMediaQuery("(max-width: 310px)");

  //. The legacy POST /api/tuzis/subscribe/{username} sends no price at
  // all, so a creator who raises member_price between this dialog rendering
  // and the fan clicking SUBSCRIBE is paid the NEW amount while the fan
  // confirmed the old one -- with every server-side check passing, because
  // by then the request itself resolves the new price. member_price allows
  // six digits, so there is no upper bound on the gap. The confirmed route
  // binds the debit to the price we RENDERED, under the creator's row lock,
  // and refuses (409 price_changed) rather than charge anything else.
  //
  // `price` is that rendered number: star.member_price until the server
  // tells us it moved, then the new one -- which the fan has to confirm
  // again. It is never retried automatically.
  const [currentPrice, setCurrentPrice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // The server did not tell us what happened. Another click could be a
  // second month, so the answer is "go and check", never "try again".
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [intentConflict, setIntentConflict] = useState(false);
  const [recoveringIntent, setRecoveringIntent] = useState(false);
  const fanRef = useRef(fan);
  const starRef = useRef(star);
  const recoveryGenerationRef = useRef(0);
  useEffect(() => {
    return () => {
      recoveryGenerationRef.current += 1;
    };
  }, []);
  fanRef.current = fan;
  starRef.current = star;
  const price = currentPrice ?? star.member_price;
  // `member_price` is NOT NULL and 0 is a FREE membership (the
  // confirmed route accepts expected_price 0 and moves no 2Z). Only a missing
  // price -- a redacted, deactivated creator -- has nothing to sell.
  const hasMemberPrice =
    price !== null && price !== undefined && `${price}` !== "" &&
    Number(price) >= 0;
  const isFree = hasMemberPrice && Number(price) === 0;

  // NOTE: the OTHER half of key retirement -- an observed active membership,
  // which is the same resolution arriving by the route the "check your
  // subscriptions" copy points at -- deliberately does NOT live here. This
  // component is not mounted while the fan is subscribed (CreatorSupport
  // renders YouAreSubscribed instead), so an effect here could never see
  // the fact it is watching for. It lives in `state/GlobalCreator`, which
  // is mounted for the whole app and holds the authoritative `stars` list.

  const recoverIntent = async () => {
    if (!fan.username || recoveringIntent) return;
    setRecoveringIntent(true);
    const identity = {
      creatorId: star.id,
      payerId: fan.id,
      username: star.username,
      payerUsername: fan.username,
    };
    const recoveryCreatorId = star.id;
    const recoveryCreatorUsername = star.username;
    const recoveryPrice = price;
    const recoveryPayerId = identity.payerId;
    const recoveryPayerUsername = identity.payerUsername;
    const recoveryGeneration = recoveryGenerationRef.current;
    const recoveryIsCurrent = () =>
      recoveryGenerationRef.current === recoveryGeneration;
    try {
      const keys = subscribeRecoveryKeys(identity);
      if (!keys.length) {
        setSnackbar({
          open: true,
          severity: "error",
          duration: undefined,
          message:
            "Sign in to the account that started the previous attempt to resolve it.",
        });
        return;
      }
      let abandonedAny = false;
      let resolvedAny = false;
      for (const key of keys) {
        if (!recoveryIsCurrent()) return;
        const response = await axios.post(
          `/api/tuzis/subscribe-recovery/${recoveryCreatorId}`,
          {
            key,
            username: recoveryCreatorUsername,
            expected_price: recoveryPrice,
          },
        );
        if (!recoveryIsCurrent()) return;
        if (response.data?.status === "abandoned") {
          markSubscribeIdempotencyAbandoned(identity, key);
          setIntentConflict(false);
          setUnconfirmed(false);
          abandonedAny = true;
          continue;
        }
        if (response.data?.status === "resolved") {
          const refreshed = await axios.get("/api/auth/user/", {
            headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
          });
          if (!recoveryIsCurrent()) return;
          const refreshedFan = refreshed.data;
          const hasCurrentPayer =
            String(refreshedFan?.id) === String(recoveryPayerId) &&
            refreshedFan?.username === recoveryPayerUsername;
          if (!hasCurrentPayer) {
            setUnconfirmed(true);
            throw new Error(
              "The previous subscription was recorded, but membership could not be confirmed. Check your subscriptions before trying again.",
            );
          }
          // A resolved receipt may describe a membership that has expired.
          // The authoritative refresh reconciles that state; the rendered
          // membership flag decides whether a fresh purchase is allowed.
          setFan(refreshedFan);
          clearSubscribeIdempotencyKey(identity, { key });
          setIntentConflict(false);
          setUnconfirmed(false);
          resolvedAny = true;
          continue;
        }
        if (response.data?.status === "unchanged") {
          setUnconfirmed(true);
          setSnackbar({
            open: true,
            severity: "error",
            duration: null,
            message:
              "The previous attempt is still pending. Check your subscriptions before trying again.",
          });
          return;
        }
      }
      const remaining = subscribeRecoveryKeys(identity);
      if (remaining.length === 0) {
        setIntentConflict(false);
        setUnconfirmed(false);
        setSnackbar({
          open: true,
          severity: "success",
          duration: null,
          message: resolvedAny
            ? "The previous subscription was already recorded."
            : abandonedAny
              ? "The previous attempt was closed. You can start a new subscription."
              : "The previous attempt was reconciled.",
        });
      } else {
        setUnconfirmed(true);
        setSnackbar({
          open: true,
          severity: "error",
          duration: undefined,
          message:
            "Resolve each outstanding subscription attempt before starting a new one.",
        });
      }
    } catch (error: any) {
      setSnackbar({
        open: true,
        severity: "error",
        duration: undefined,
        message:
          error?.response?.data?.error ||
          "The previous attempt could not be resolved.",
      });
    } finally {
      setRecoveringIntent(false);
    }
  };

  return (
    <>
      {/* <DialogTitle id="responsive-dialog-title">
                Subscribe to {star.full_name || star.username}
            </DialogTitle> */}
      <DialogContent>
        {hasMemberPrice ? (
          <DialogContentText>
            {isFree ? (
              <>
                Free membership: follow {star.full_name || star.username} for
                free and get 30 days of access to livestreams and other
                members-only content.
              </>
            ) : (
              <>
                For {price} 2Zs per month, support{" "}
                {star.full_name || star.username} and get access to livestreams
                and other members-only content.
              </>
            )}
          </DialogContentText>
        ) : (
          <DialogContentText>
            {star.full_name || star.username} has not set a membership price
            yet.
          </DialogContentText>
        )}
        {currentPrice !== null && (
          <DialogContentText color="warning.main">
            The membership price changed since this page loaded. Review the new
            price and confirm again.
          </DialogContentText>
        )}
        {fan.username ? (
          <>
            <DialogContentText>
              You have {Number(fan.tuzis).toFixed(0)} 2Zs
            </DialogContentText>
            <Stack direction="row" alignItems="center" justifyContent="center">
              <Tuzis {...fan} />
            </Stack>
          </>
        ) : (
          <LoginMessageStack message={"Log in to subscribe"} />
        )}
      </DialogContent>
      <DialogActions
        style={{
          padding: "1em",
        }}
      >
        <Button
          color="warning"
          onClick={
            props.onCloseClick ||
            (() => {
              // console.log("Close modal from exit button")
              props.setShowPay(false);

              if (location.pathname !== `/${star.username}`) {
                navigate(-1);
              }
            })
          }
        >
          Close
        </Button>
        {fan.username && hasMemberPrice && (
          <>
            {(intentConflict || unconfirmed) && (
              <>
                <Button
                  variant="contained"
                  color="warning"
                  disabled={recoveringIntent}
                  onClick={recoverIntent}
                >
                  {recoveringIntent
                    ? "Resolving..."
                    : "Resolve previous attempt"}
                </Button>
                <DialogContentText>
                  Sign in to the account that started the previous attempt. No
                  payment data is shared with this account.
                </DialogContentText>
              </>
            )}
            {Number(fan.tuzis) >= Number(price) &&
              !intentConflict &&
              !unconfirmed && (
                <Button
                  variant="contained"
                  color="success"
                  disabled={submitting || unconfirmed}
                  onClick={() => {
                    if (submitting || unconfirmed) {
                      return;
                    }
                    setSubmitting(true);
                    setIntentConflict(false);
                    // Captured at the click, not re-read later: this
                    // is the number the fan is confirming.
                    const expectedPrice = price;
                    // Stable across the retry an ambiguous response
                    // invites, and shared with the new-ui bundle
                    // through localStorage, so a fan bounced between
                    // the two by @classic_fallback mid-purchase is
                    // still ONE purchase intent.
                    const subscriptionIdentity = {
                      creatorId: star.id,
                      payerId: fan.id,
                      username: star.username,
                      payerUsername: fan.username,
                    };
                    let headers: Record<string, string>;
                    try {
                      headers =
                        subscribeIdempotencyHeaders(subscriptionIdentity);
                    } catch (error: any) {
                      setSubmitting(false);
                      if (
                        error?.code === "idempotency_storage_unavailable" ||
                        error?.code === "idempotency_adoption_conflict"
                      ) {
                        if (error?.code === "idempotency_adoption_conflict") {
                          setIntentConflict(true);
                        }
                        setSnackbar({
                          open: true,
                          message:
                            error?.code === "idempotency_adoption_conflict"
                              ? "A previous subscription request belongs to another account or creator. Resolve it before retrying. This attempt was not sent."
                              : "Your browser could not save the subscription retry key. Restore site storage and check any previous payment before retrying. This attempt was not sent.",
                          severity: "error",
                          duration: undefined,
                        });
                        return;
                      }
                      throw error;
                    }
                    axios
                      .post(
                        `/api/tuzis/subscribe-confirmed/${star.username}`,
                        { expected_price: expectedPrice, creator_id: star.id },
                        { headers },
                      )
                      .then((res) => {
                        // Retire the key only on a confirmed success:
                        // the next subscribe is a NEW purchase and
                        // must not replay this one.
                        clearSubscribeIdempotencyKey(subscriptionIdentity, {
                          key: headers?.["Idempotency-Key"],
                        });
                        axios.get("/api/auth/user/").then((res) => {
                          setFan(res.data);
                        });
                        props.setShowPay(false);
                        setSnackbar({
                          open: true,
                          message: res.data?.replayed
                            ? `This subscription to ${
                                star.full_name || star.username
                              } was already recorded`
                            : `Successfully subscribed to ${
                                star.full_name || star.username
                              }`,
                          severity: "success",
                          duration: null,
                        });
                        if (props.memberPage) {
                          // redirect to a specific page after subscribing
                          navigate(`${props.memberPage}`);
                        }
                      })
                      .catch((err) => {
                        // An axios error carries the body under
                        // `response.data`; the old `err.data.error`
                        // was always undefined and threw here.
                        const data = err?.response?.data;
                        if (
                          err?.response?.status === 402 ||
                          data?.code === "insufficient_funds"
                        ) {
                          // A recognized insufficient-funds response is a
                          // completed no-charge result. An unrecognized 402
                          // has no such evidence, so retain the stable key
                          // and offer recovery like another uncertain outcome.
                          if (data?.code !== "insufficient_funds") {
                            setUnconfirmed(true);
                          }
                          setSnackbar({
                            open: true,
                            message: data?.error ||
                              (data?.code === "insufficient_funds"
                                ? "You have not been charged. Add 2Z to your balance and try again."
                                : "The subscription outcome could not be confirmed. Resolve the previous attempt before trying again."),
                            duration: undefined,
                            severity: "error",
                          });
                          return;
                        }
                        if (data?.code === "subscription_intent_abandoned") {
                          // Recovery has permanently fenced this key. Retire
                          // only the answered key so a new deliberate
                          // purchase can proceed.
                          clearSubscribeIdempotencyKey(subscriptionIdentity, {
                            key: headers?.["Idempotency-Key"],
                          });
                          setIntentConflict(false);
                          setUnconfirmed(false);
                          setSnackbar({
                            open: true,
                            message:
                              "The previous attempt was closed. You can start a new subscription.",
                            duration: undefined,
                            severity: "error",
                          });
                          return;
                        }
                        if (
                          data?.code === "price_changed" &&
                          data?.current_price
                        ) {
                          // Nothing was charged and the key was
                          // released. Show the NEW number and make
                          // the fan confirm it; never auto-retry.
                          setCurrentPrice(String(data.current_price));
                          setSnackbar({
                            open: true,
                            message: `The membership price changed from ${expectedPrice} 2Zs to ${data.current_price} 2Zs since this page loaded. Review the new price and confirm again.`,
                            duration: undefined,
                            severity: "error",
                          });
                          return;
                        }
                        if (data?.code === "creator_changed") {
                          setUnconfirmed(true);
                          setSnackbar({
                            open: true,
                            message:
                              "The creator changed before this purchase completed. Refresh and review the subscription again.",
                            duration: undefined,
                            severity: "error",
                          });
                          return;
                        }
                        if (
                          data?.code === "idempotency_mismatch" &&
                          data?.key_resolved
                        ) {
                          // The server PROVED the request recorded
                          // under this key FINISHED and cannot be
                          // the one being made now -- another
                          // creator's, or a month that has since
                          // ended. Keeping it answers 409 to every
                          // attempt for the receipt's whole 365-day
                          // horizon (codex adversarial review of
                          // ). Retire it; the next deliberate
                          // click mints a fresh one. Never on a
                          // bare mismatch: an unfinished claim may
                          // be a charge that is still committing,
                          // and a finished receipt for a membership
                          // still IN HAND replays as a 200 instead,
                          // never with this flag.
                          clearSubscribeIdempotencyKey(subscriptionIdentity, {
                            key: headers?.["Idempotency-Key"],
                          });
                          setSnackbar({
                            open: true,
                            message:
                              "That attempt has already been settled. Try subscribing again.",
                            duration: undefined,
                            severity: "error",
                          });
                          return;
                        }
                        if (
                          data?.code === "request_in_progress" ||
                          data?.code === "idempotency_mismatch"
                        ) {
                          setUnconfirmed(true);
                          setSnackbar({
                            open: true,
                            message:
                              "The server did not confirm the subscription. Check your subscriptions before trying again.",
                            duration: undefined,
                            severity: "error",
                          });
                          return;
                        }
                        setSnackbar({
                          message:
                            data?.error ||
                            data?.message ||
                            "Failed to subscribe.",
                          open: true,
                          duration: undefined,
                          severity: "error",
                        });
                      })
                      .finally(() => {
                        setSubmitting(false);
                      });
                  }}
                >
                  {isFree ? "FOLLOW — FREE" : "SUBSCRIBE"}
                </Button>
              )}
          </>
        )}
      </DialogActions>
    </>
  );
};

export default function SubscribeToCreator(
  props: SubscribeToCreatorProps & { children?: ReactNode },
) {
  const { showPay, setShowPay, star, children } = props;
  const [fan, setFan] = useGlobalState("creator");
  const setSnackbar = useGlobalState("snackbar")[1];

  const navigate = useTransitionNavigate();
  const location = useLocation();

  const isXS = useMediaQuery("(max-width: 310px)");

  return (
    <Dialog
      fullScreen={isXS}
      fullWidth
      maxWidth="sm"
      open={showPay}
      onClose={() => {
        // TODO: non-happy cases
        // console.log("Close modal from dialog 'non-happy' cases")
        setShowPay(false);
      }}
      aria-labelledby="responsive-dialog-title"
    >
      {children || <CreatorSubscribeContent {...props} />}
    </Dialog>
  );
}
