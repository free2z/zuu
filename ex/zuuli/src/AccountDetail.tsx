import { CircularProgress, Divider, Modal, Paper, Typography } from "@mui/material";
import React from "react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import QRDialog from "./components/QRDialog";
// import QRModal from "./components/QRModal";

import { useGlobalState } from "./db/db";



export default function AccountDetail() {
    const [account, setAccount] = useGlobalState('currentAccount')
    const [loading, setLoading] = React.useState(true)

    if (!account || !account.id_account) {
        // assume we might get somewhere eventually?
        // shouldn't probably ever happen for more than a split second
        return (
            <Modal
                open={loading}
                style={{
                    width: "100%",
                    height: "100vh",
                    background: "black",
                }}
            >
                <CircularProgress
                    color="secondary"
                    style={{
                        width: "100%",
                        height: "100vh",
                        // margin: "0 auto",
                    }}
                />
            </Modal>
        )
    }

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
                variant="inset"
                style={{ margin: "2em 10%" }}
            >
                <QRDialog
                    title={"Shielded Zaddress (Sapling)"}
                    content={account.address}
                    button={"Shielded zAddress"}
                    color="success"
                />
            </Divider>

            <Divider
                variant="inset"
                style={{ margin: "2em 10%" }}
            >
                <QRDialog
                    title={"Transparent Address"}
                    content={account.taddress}
                    button={"Transparent Address"}
                    color="primary"
                />
            </Divider>

            <Divider
                variant="inset"
                style={{ margin: "2em 10%" }}
            >


                <QRDialog
                    title={"Incoming Viewing Key"}
                    content={account.ivk}
                    button={"Viewing Key"}
                    color="secondary"
                />
            </Divider>

            <Divider
                variant="inset"
                style={{ margin: "2em 10%" }}
            >
                <QRDialog
                    title={"SECRET Key"}
                    content={account.sk}
                    button={"Secret Key"}
                    color="warning"
                />
            </Divider>
            <Divider
                variant="inset"
                style={{ margin: "2em 10%" }}
            >
                <QRDialog
                    title={"Seed Phrase"}
                    content={account.seed}
                    button={"Seed Phrase"}
                    color="error"
                />
            </Divider>
        </Paper >
    )
}
