import { CircularProgress, Divider, Paper, Typography } from "@mui/material";
import React from "react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import QRDialog from "./components/QRDialog";
// import QRModal from "./components/QRModal";

import { useGlobalState } from "./db/db";



export default function AccountDetail() {
    const [account, setAccount] = useGlobalState('currentAccount')

    if (!account.id_account) {
        // assume we might get somewhere eventually?
        // shouldn't probably ever happen for more than a split second
        return <CircularProgress />
    }

    // console.log(account)

    return (
        <Paper
            elevation={3}
            style={{
                height: "100%",
                padding: "0.25em",
                paddingBottom: "13px",
                textAlign: "center",
            }}
        >
            <Typography variant="h4">
                {account.name}
            </Typography>

            <Divider
                variant="middle"
                style={{ margin: "0.5em 3em" }}
            />
            <QRDialog
                title={"Shielded Zaddress (Sapling)"}
                content={account.address}
                button={"Shielded zAddress"}
                color="success"
            />

            <Divider
                variant="middle"
                style={{ margin: "0.5em 3em" }}
            />
            <QRDialog
                title={"Transparent Address"}
                content={account.taddress}
                button={"Transparent Address"}
                color="primary"
            />

            <Divider
                variant="middle"
                style={{ margin: "0.5em 3em" }}
            />


            <QRDialog
                title={"Incoming Viewing Key"}
                content={account.ivk}
                button={"Viewing Key"}
                color="secondary"
            />

            <Divider
                variant="middle"
                style={{ margin: "0.5em 3em" }}
            />
            <QRDialog
                title={"SECRET Key"}
                content={account.sk}
                button={"Secret Key"}
                color="warning"
            />
            <Divider
                variant="middle"
                style={{ margin: "0.5em 3em" }}
            />
            <QRDialog
                title={"Seed Phrase"}
                content={account.seed}
                button={"Seed Phrase"}
                color="error"
            />
            <Divider
                variant="middle"
                style={{ margin: "0.5em 3em" }}
            />
        </Paper >
    )
}
