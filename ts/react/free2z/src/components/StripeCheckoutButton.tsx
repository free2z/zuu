import React, { useState, useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import {
  Button,
  CircularProgress,
  TextField,
  Typography,
  Stack,
  Divider,
  Box,
  Grid,
  InputAdornment,
} from "@mui/material";
// import { Stripe, loadStripe, StripeError } from '@stripe/stripe-js';
import axios from "axios";
import TuziIcon from "./TuziIcon";
import useTuziPricing, {
  cardFeeCents,
  estimatedCardCents,
} from "../hooks/useTuziPricing";

const STRIPE_CHECKOUT_ENABLED =
  process.env.REACT_APP_STRIPE_CHECKOUT_ENABLED === "true";

function isStripeHostedCheckoutUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "checkout.stripe.com" &&
      parsed.port === "" &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

interface CheckoutSession {
  id: string;
  url: string;
  quote: {
    checkout_intent_id: string;
    tuzis: number;
    amount_cents: number;
    currency: "usd";
    pricing_version: string;
  };
}

const StripeCheckoutButton: React.FC<{
  expectedActorId: number;
  expectedUsername: string;
}> = ({ expectedActorId, expectedUsername }) => {
  const [loading, setLoading] = useState<boolean>(false);
  const [quantity, setQuantity] = useState<number>(1000);
  const [total, setTotal] = useState<number>(0);
  const [checkoutSession, setCheckoutSession] =
    useState<CheckoutSession | null>(null);
  const requestSequence = useRef(0);
  const actorRef = useRef({ id: expectedActorId, username: expectedUsername });
  actorRef.current = { id: expectedActorId, username: expectedUsername };
  const [reviewedActor, setReviewedActor] = useState<{
    id: number;
    username: string;
  } | null>(null);
  const location = useLocation();
  // Live fee shape from /api/pricing/ so this preview cannot drift from the
  // backend's card-v3 formula. The authoritative charge is still the quote the
  // server returns with the Checkout Session, shown before "Continue to Stripe".
  const { pricing } = useTuziPricing();
  const validQuantity =
    Number.isInteger(quantity) && quantity >= 1 && quantity <= 1_000_000;
  const feeCents = validQuantity ? cardFeeCents(quantity, pricing) : 0;

  useEffect(() => {
    setTotal(validQuantity ? estimatedCardCents(quantity, pricing) : 0);
    requestSequence.current += 1;
    setCheckoutSession(null);
    setReviewedActor(null);
    setLoading(false);
  }, [quantity, pricing, validQuantity, expectedActorId, expectedUsername]);

  const handleCheckout = async () => {
    setLoading(true);
    const sequence = ++requestSequence.current;
    const original = { id: expectedActorId, username: expectedUsername };
    const stillCurrent = () =>
      sequence === requestSequence.current &&
      actorRef.current.id === original.id &&
      actorRef.current.username === original.username;
    try {
      const originalActor = original.id;
      const identity = await axios.get("/api/auth/user/", {
        headers: { "Cache-Control": "no-cache" },
      });
      if (
        !Number.isSafeInteger(originalActor) ||
        originalActor <= 0 ||
        identity.data.id !== originalActor ||
        identity.data.username !== original.username ||
        !stillCurrent()
      ) {
        throw new Error("Sign in again before continuing.");
      }
      const response = await axios.post(
        "/api/stripe/create-checkout-session/",
        {
          quantity,
          expected_actor_id: originalActor,
          currentPath: location.pathname,
        },
      );

      if (response.status !== 200) {
        throw new Error("Failed to create checkout session.");
      }

      if (!stillCurrent()) return;
      const session: CheckoutSession = response.data;
      if (
        !session ||
        typeof session.id !== "string" ||
        !session.id ||
        !isStripeHostedCheckoutUrl(session.url) ||
        !session.quote ||
        session.quote.tuzis !== quantity ||
        !Number.isInteger(session.quote.amount_cents) ||
        session.quote.amount_cents < 1 ||
        session.quote.currency !== "usd" ||
        !session.quote.pricing_version
      ) {
        throw new Error("Stripe returned an invalid checkout quote.");
      }
      setReviewedActor(original);
      setCheckoutSession(session);
    } catch (error: any) {
      if (stillCurrent())
        alert(error.message?.toString() || "Something went wrong.");
    } finally {
      if (stillCurrent()) setLoading(false);
    }
  };

  const continueToStripe = async () => {
    if (!checkoutSession || !reviewedActor) return;
    const sequence = ++requestSequence.current;
    setLoading(true);
    try {
      const original = reviewedActor;
      const identity = await axios.get("/api/auth/user/", {
        headers: { "Cache-Control": "no-cache" },
      });
      if (
        identity.data.id !== original.id ||
        identity.data.username !== original.username ||
        actorRef.current.id !== original.id ||
        actorRef.current.username !== original.username
      ) {
        throw new Error("Sign in again before continuing.");
      }
      if (sequence !== requestSequence.current) return;
      window.location.assign(checkoutSession.url);
    } catch (error: any) {
      if (sequence === requestSequence.current)
        alert(error.message?.toString() || "Something went wrong.");
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  };

  const disabled =
    loading ||
    !STRIPE_CHECKOUT_ENABLED ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 1_000_000;

  return (
    <Stack
      direction="column"
      spacing={3}
      alignItems="center"
      justifyContent="center"
      sx={{
        padding: 1,
        // border: '1px solid #e0e0e0',
        // borderRadius: 2,
      }}
    >
      <Typography variant="caption" align="center">
        Tuzis Calculator
      </Typography>
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        justifyContent="center"
        textAlign={"center"}
      >
        <TextField
          label="Number of Tuzis"
          type="number"
          variant="outlined"
          value={quantity}
          onChange={(e) => setQuantity(Number(e.target.value))}
          sx={{ maxWidth: "170px", textAlign: "center" }}
          InputProps={{
            inputProps: { style: { textAlign: "center" } },
            endAdornment: (
              <InputAdornment position="start">
                <TuziIcon />
              </InputAdornment>
            ),
          }}
        />
      </Stack>
      <Box
        component="div"
        display="flex"
        flexDirection="column"
        alignItems="center"
        width="250px"
      >
        <Grid container spacing={1}>
          <Grid item xs={6}>
            <Typography align="left">Tuzis</Typography>
          </Grid>
          <Grid item xs={6} container justifyContent="flex-end">
            <Typography align="right">{`${quantity}`}</Typography>
          </Grid>
        </Grid>

        <Grid container spacing={1}>
          <Grid item xs={6}>
            <Typography align="left">+ Card fee</Typography>
          </Grid>
          <Grid item xs={6} container justifyContent="flex-end">
            <Typography align="right">
              {(feeCents / 100).toLocaleString("en-US", {
                style: "currency",
                currency: "USD",
              })}
            </Typography>
          </Grid>
        </Grid>

        <Divider sx={{ width: "100%", marginY: 1 }} />

        <Grid container spacing={1}>
          <Grid item xs={6}>
            <Typography align="left">Estimated total</Typography>
          </Grid>
          <Grid item xs={6} container justifyContent="flex-end">
            <Typography variant="h6" align="right">
              {(total / 100).toLocaleString("en-US", {
                style: "currency",
                currency: "USD",
              })}
            </Typography>
          </Grid>
        </Grid>
      </Box>
      <Button
        variant="contained"
        color="primary"
        disabled={disabled}
        onClick={handleCheckout}
        startIcon={loading ? <CircularProgress size="1rem" /> : null}
      >
        Review exact charge
      </Button>
      {checkoutSession &&
        reviewedActor?.id === expectedActorId &&
        reviewedActor.username === expectedUsername && (
          <Stack
            spacing={1}
            alignItems="center"
            aria-label="Authoritative card quote"
          >
            <Typography variant="body2">Exact card charge</Typography>
            <Typography variant="h6">
              {(checkoutSession.quote.amount_cents / 100).toLocaleString(
                "en-US",
                { style: "currency", currency: "USD" },
              )}
            </Typography>
            <Typography variant="body2">
              {checkoutSession.quote.tuzis} 2Z
            </Typography>
            <Button
              variant="contained"
              color="primary"
              disabled={loading}
              onClick={continueToStripe}
            >
              Continue to Stripe
            </Button>
          </Stack>
        )}
    </Stack>
  );
};

export default StripeCheckoutButton;
