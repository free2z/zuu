import { AttachMoney, QuestionMarkRounded } from "@mui/icons-material";
import {
    Dialog, DialogTitle, DialogContent, DialogActions,
    Button, Typography, Stack, Tab, Tabs, useMediaQuery,
} from "@mui/material";
import React, { useState } from "react";
import { Creator } from "../Begin";
import StripeCheckoutButton from "./StripeCheckoutButton";
import ZcashIcon from "./ZcashIcon";
import { TabPanel } from "./TabPanel";
import { BOOTSTRAP_TUZIS_PER_ZEC } from "../hooks/useTuziPricing";

// Cold-start display estimate only; the live, spread-adjusted rate comes from
// useTuziPricing (/api/pricing/) — see issue. Re-exported for callers
// that need a non-zero number before the first fetch resolves.
export const BOOTSTRAP_TUZIS_PER_ZEC_DISPLAY = BOOTSTRAP_TUZIS_PER_ZEC
export const DEFAULT_TUZI_AMOUNT = 2500


type TuzisDialogProps = Creator & {
    open: boolean
    setOpen: React.Dispatch<React.SetStateAction<boolean>>
}

export default function TuzisDialog(props: TuzisDialogProps) {
    const { open, setOpen } = props
    const [tabValue, setTabValue] = useState(0);
    // const isMobile = window.innerWidth < 600
    const isSmallerScreen = useMediaQuery('(max-width: 500px)');

    const handleClose = () => {
        setOpen(false)
    }

    const handleTabChange = (event: React.SyntheticEvent, newValue: number) => {
        setTabValue(newValue);
    };
    return (
        <Dialog
            // fullScreen={fullScreen}
            fullScreen={isSmallerScreen}
            fullWidth
            open={open}
            onClose={handleClose}
            aria-labelledby="responsive-dialog-title"
            maxWidth="sm"
        >
            <DialogTitle id="responsive-dialog-title">
                <Stack
                    direction="column"
                    spacing={1}
                    alignItems="center"
                    justifyContent="right"
                >
                    <Typography variant="h5">
                        Buy 2Zs
                    </Typography>
                    <Typography variant="caption">
                        You have {Number(props.tuzis).toFixed(0)}
                    </Typography>
                </Stack>
            </DialogTitle>
            <DialogContent
                style={{
                    minHeight: "465px",
                }}
            >
                <Tabs value={tabValue} onChange={handleTabChange} centered>
                    <Tab icon={<QuestionMarkRounded />} />
                    <Tab icon={<AttachMoney />} />
                    <Tab icon={<ZcashIcon />} />
                </Tabs>

                <TabPanel value={tabValue} index={0} p={2}>
                    <Stack
                        direction="column"
                        spacing={isSmallerScreen ? 1 : 2}
                        alignItems="center"
                        justifyContent="center"
                        // textAlign="left"
                        style={{
                            height: "100%",
                            width: "100%",
                        }}
                        sx={{
                            // paddingTop:,
                        }}
                    >
                        <Typography variant="h6">What are 2Zs?</Typography>
                        <Typography variant="caption"
                            style={{
                                width: isSmallerScreen ? "100%" : "88%"
                            }}
                        >
                            2Zs are usage credits for Free2Z services, including
                            subscriptions, commenting, voting, AI and livestream access.
                            Sharing or receiving usage credits does not itself establish USD earnings.
                            Creator earnings are recorded separately in Credits &amp; Earnings.

                        </Typography>
                        <Stack
                            direction="row"
                            spacing={1}
                            alignItems="center"
                            justifyContent="center"
                            style={{ marginTop: isSmallerScreen ? '0.77em' : '1.5em' }}
                        >
                            <Button
                                variant="contained"
                                color="primary"
                                // size="large"
                                onClick={() => setTabValue(1)}
                                startIcon={<AttachMoney />}
                            >
                                Card
                            </Button>
                            <Button
                                variant="outlined"
                                color="success"
                                // size="large"
                                onClick={() => setTabValue(2)}
                                startIcon={<ZcashIcon />}
                            >
                                Zcash
                            </Button>
                        </Stack>
                    </Stack>
                </TabPanel>

                <TabPanel value={tabValue} index={1} p={2}>
                    <StripeCheckoutButton expectedActorId={props.id} expectedUsername={props.username} />
                </TabPanel>
                <TabPanel value={tabValue} index={2} p={2}>
                    <Stack spacing={2} alignItems="center">
                        <Typography align="center">
                            Open Credits &amp; Earnings to review the Zcash estimate and purchase terms.
                            Use the payment address and memo shown there when sending.
                        </Typography>
                        <Button component="a" href={`/${encodeURIComponent(props.username)}/dashboard/billing?tab=zcash`} variant="contained">
                            Buy credits with Zcash
                        </Button>
                    </Stack>
                </TabPanel>
            </DialogContent>

            <DialogActions>
                <Button onClick={handleClose} autoFocus>
                    Close
                </Button>
            </DialogActions>
        </Dialog>
    );
};
