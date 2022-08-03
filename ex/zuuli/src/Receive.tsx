import React from "react";
import { CircularProgress } from "@mui/material";
import AddressTabs from "./components/AddressTabs";

import { useGlobalState } from "./db/db";



export default function Receive() {
    const [account, setAccount] = useGlobalState('currentAccount')

    if (!account.id_account) {
        // assume we might get somewhere eventually?
        // shouldn't probably ever happen for more than a split second
        return <CircularProgress />
    }

    return (
        <AddressTabs account={account} />
    )
}
