import React, { useState, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import {
    Button, CircularProgress, TextField, Typography,
    Stack, Divider, Box, Grid, InputAdornment
} from '@mui/material';
// import { Stripe, loadStripe, StripeError } from '@stripe/stripe-js';
import axios from 'axios';
import TuziIcon from './TuziIcon';


const STRIPE_PK = 'pk_live_51M6L9VFmJRpoXkMjPvhqONZXBjVLLNzZ2VZMIlVengT9wNfLcL5ndLxXkRN3O46c9cu4e4XI3JBp0ipgIUPXkc0g007CNLZhaD';

interface CheckoutSession {
    id: string;
}

const StripeCheckoutButton: React.FC = () => {
    const [loading, setLoading] = useState<boolean>(false);
    const [quantity, setQuantity] = useState<number>(1000);
    const [total, setTotal] = useState<number>(0);
    const location = useLocation()

    // stripeModule.Stripe | null
    const stripeRef = useRef<any>(null);

    const loadStripeInstance = async () => {
        if (!stripeRef.current) {
            const stripeModule = await import('@stripe/stripe-js');
            const stripe = await stripeModule.loadStripe(STRIPE_PK);
            stripeRef.current = stripe;
        }
        return stripeRef.current;
    }

    useEffect(() => {
        const newTotal = quantity + (quantity * 0.05) + 100;
        setTotal(newTotal);
    }, [quantity]);

    const handleCheckout = async () => {
        setLoading(true);
        try {
            const stripe = await loadStripeInstance();
            if (!stripe) {
                throw new Error("Stripe library couldn't be loaded.");
            }

            // Call your backend to create the Checkout Session, passing quantity.
            const response = await axios.post('/api/stripe/create-checkout-session/', {
                quantity, currentPath: location.pathname,
            });

            if (response.status !== 200) {
                throw new Error("Failed to create checkout session.");
            }

            const session: CheckoutSession = response.data;

            const { error } = await stripe.redirectToCheckout({
                sessionId: session.id,
            });

            if (error) {
                throw error;
            }
        } catch (error: any) {
            console.error("Error in the checkout process:", error);
            alert(error.message?.toString() || "Something went wrong.");
        } finally {
            setLoading(false);
        }
    };

    const disabled = loading || isNaN(quantity) || quantity < 1;

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
                    onChange={(e) => setQuantity(Math.max(1, parseInt(e.target.value)))}
                    sx={{ maxWidth: '170px', textAlign: 'center' }}
                    InputProps={{
                        inputProps: { style: { textAlign: 'center' } },
                        endAdornment: (
                            <InputAdornment position="start">
                                <TuziIcon />
                            </InputAdornment>
                        ),
                    }}
                />
            </Stack>
            <Box component="div" display="flex" flexDirection="column" alignItems="center" width="250px">
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
                        <Typography align="left">+ 5%</Typography>
                    </Grid>
                    <Grid item xs={6} container justifyContent="flex-end">
                        <Typography align="right">{`${Math.floor(quantity * 0.05)}`}</Typography>
                    </Grid>
                </Grid>

                <Grid container spacing={1}>
                    <Grid item xs={6}>
                        <Typography align="left">+ Fee</Typography>
                    </Grid>
                    <Grid item xs={6} container justifyContent="flex-end">
                        <Typography align="right">{`100`}</Typography>
                    </Grid>
                </Grid>

                <Divider sx={{ width: '100%', marginY: 1 }} />

                <Grid container spacing={1}>
                    <Grid item xs={6}>
                        {/* You can leave this empty or put any label if necessary */}
                    </Grid>
                    <Grid item xs={6} container justifyContent="flex-end">
                        <Typography variant="h6" align="right">
                            {(total / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}
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
                Buy with Stripe
            </Button>
        </Stack>
    );
};

export default StripeCheckoutButton;
