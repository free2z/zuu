import React from "react";

import { Box, Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, Grid, IconButton, TextField, Typography } from "@mui/material";
import { Balance } from "@mui/icons-material";
import { useGlobalState, getBalance, z } from "./db/db";

const ZatToZEC = 100000000

export function SliceAddress(address: string): string {
    const l = address.length
    return `${address.slice(0, 5)} ... ${address.slice(l - 5, l)}`
}


export default function Send() {
    const [account, setAccount] = useGlobalState('currentAccount')

    const [confirmOpen, setConfirmOpen] = React.useState(false)
    const [address, setAddress] = React.useState("")
    const [amount, setAmount] = React.useState(0)
    const [memo, setMemo] = React.useState("")

    const balance = getBalance(account)

    function handleClose() {
        setConfirmOpen(false)
    }

    function handleSend() {
        console.log("TODO: BLOCK ALL UI INTERACTION")
        const json = JSON.stringify([{
            address: address,
            memo: memo,
            amount: amount * ZatToZEC,
            // TODO: implement?
            reply_to: false,
            subject: "",  // ???
            max_amount_per_note: 9999999999999,  // ????
        }])
        console.log(json)
        // set globally?
        console.log(account)
        setConfirmOpen(false)

        // TODO: put over IPC! send blocks the UI!
        // TODO: is this setActive needed?
        z.setActive(account.id_account)
        const res = z.send(json)
        console.log("DONE!")
        console.log(res)
    }

    return (
        <Box
            component="form"
            sx={{
                // '& > :not(style)': { m: 1, width: '25ch' },
                width: "777px",
                margin: "0 auto",
                maxWidth: "93%",
                // flexDirection: 'row',
                // display: 'flex',
                p: 1,
                bgcolor: 'background.paper',
                borderRadius: 1,
            }}
        // noValidate
        // autoComplete="off"
        >

            <TextField
                label="Address or payment URI"
                variant="standard"
                fullWidth
                margin="normal"
                color="primary"
                value={address}
                onChange={(ev) => {
                    setAddress(ev.target.value)
                }}
                style={{
                    marginBottom: "2em",
                }}
            />

            <TextField
                // id="outlined-number"
                label="Amount"
                type="number"
                value={amount}
                onChange={(ev) => {
                    setAmount(parseFloat(ev.target.value))
                }}
                style={{
                    marginBottom: "1em",
                }}
                fullWidth
                // endAd
                InputProps={{
                    inputProps: {
                        min: 0,
                        max: 100000,
                        step: 0.0001,
                    },

                    // shrink: true,
                    endAdornment: (
                        <Button
                            style={{
                                margin: "1 em"
                            }}
                            variant="outlined"
                            onClick={() => {
                                // TODO: this is crude
                                setAmount(
                                    ((balance - 10000) / ZatToZEC)
                                )
                            }}
                        >
                            {`${(balance - 10000) / ZatToZEC}`}
                            <Balance
                                fontSize="large"
                            />
                        </Button>
                    ),
                }}
            />


            <TextField
                label="Memo"
                multiline
                rows={6}
                fullWidth
                // TODO: default in settings
                // defaultValue="Default Value"
                // TODO: random placeholder lol
                placeholder="Sent from ZUULI"
                margin="normal"
                color="secondary"
                value={memo}
                onChange={(ev) => {
                    setMemo(ev.target.value)
                }}
            />
            <Button
                onClick={() => {
                    setConfirmOpen(true)
                }}
            >SEND!</Button>
            <Dialog
                open={confirmOpen}
                onClose={handleClose}
                sx={{ minWidth: "399px" }}
            >
                <DialogTitle id="alert-dialog-title">
                    {"Send?"}
                </DialogTitle>
                <DialogContent>
                    {/* <DialogContentText id="alert-dialog-description"> */}
                    <Typography>
                        To: {SliceAddress(address)}
                    </Typography>
                    <Typography>
                        Amount: {amount}</Typography>
                    <Typography>
                        Memo: {memo}
                    </Typography>
                    {/* </DialogContentText> */}
                </DialogContent>
                <DialogActions>
                    <Button
                        onClick={handleClose}
                        color="warning"
                    >
                        Cancel
                    </Button>
                    <Button
                        onClick={handleSend}
                        autoFocus
                    >
                        Send
                    </Button>
                </DialogActions>
            </Dialog>
            {/* </Box> */}
        </Box >
    );
}
