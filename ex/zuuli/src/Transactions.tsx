import React from "react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import TxGrid from "./components/TxGrid";

import { Grid, Box } from "@mui/material"
import { Transaction, useGlobalState, z } from "./db/db"

export default function Transactions() {

    // One global state handler? Probably
    //
    // const [txs, setTXs] = React.useState([] as Transaction[])
    // const [account, setAccount] = useGlobalState("currentAccount")
    // if (!account) {
    //     return <></>
    // }

    // const refresh = async () => {
    //     if (!account || !account.id_account) {
    //         return
    //     }
    //     console.log("GET TX ID", account.id_account)
    //     const txs = await z.getTransactions(account.id_account)
    //     console.log("REFRESH txs", txs)
    //     setAccount({
    //         ...account,
    //         transactions: txs,
    //     })
    // }


    // React.useEffect(() => {
    //     refresh()
    // }, [])

    return (

        <TxGrid

        />
    )
}
