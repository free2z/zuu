import { AttachMoney, QuestionMarkRounded } from "@mui/icons-material";
import {
    Dialog, DialogTitle, DialogContent, DialogActions,
    Button, Typography, Stack, Tab, Tabs, useMediaQuery, Link,
} from "@mui/material";
import React, { useState } from "react";
import { Creator } from "../Begin";
import { getURI, current_f2z_address } from "../Constants";
import AmountSlider from "./AmountSlider";
import QRAddress from "./QRAddress";
import StripeCheckoutButton from "./StripeCheckoutButton";
import ZcashIcon from "./ZcashIcon";
import { TabPanel } from "./TabPanel";

// TODO: make dynamic
export const TUZI_PER_ZEC = 2500
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
    // Maybe we want to try to pin 2Zs closer to a penny USD and try to
    // make it more stable than Zcash ultimately. But, for now we'll
    // just introduce it at 0.0001 Zcash which at time of comment is closer
    // to $0.003. Limited time only?
    // https://medium.com/hackernoon/fetching-crypto-price-with-react-3a49f41bf80c
    const [amount, setAmount] = React.useState(DEFAULT_TUZI_AMOUNT)

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
                            // paddingTop: ,
                        }}
                    >
                        <Typography variant="h6">What are 2Zs?</Typography>
                        <Typography variant="caption"
                            style={{
                                width: isSmallerScreen ? "100%" : "88%"
                            }}
                        >
                            2Zs are points worth $0.01 on our platform.
                            With 2Zs, you can support creators through donations and
                            subscriptions and engage in activities like commenting,
                            voting, boosting content, and accessing AI and livestream features.
                            Qualified creators can redeem 2Zs for
                            up to their full value of $0.01.
                            You don't have to buy them, you can make a cool profile and {` `}
                            <Link
                                href="https://free2z.com/docs/for-creators/creating-a-profile"
                                target="_blank"
                                rel="noopener"
                            >
                                earn them
                            </Link>
                            {` `}with donations, subscriptions and pay-per-view livestreams.

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
                    <StripeCheckoutButton />
                </TabPanel>
                <TabPanel value={tabValue} index={2} p={2}>

                    <Stack
                        direction="column"
                        spacing={2}
                        alignItems="center"
                        justifyContent="center"
                        sx={{
                            paddingTop: 1,
                            // border: '1px solid #e0e0e0',
                            // borderRadius: 2,
                        }}
                    >
                        <Typography variant="caption" align="center">
                            Buy 2Zs with Zcash
                        </Typography>
                        <QRAddress
                            size={180}
                            addr={getURI(
                                current_f2z_address,
                                String(amount / TUZI_PER_ZEC),
                                JSON.stringify({
                                    act: "buy_2z",
                                    id: props.username,
                                })
                            )}
                        />
                        <AmountSlider value={amount} setValue={setAmount} />
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
