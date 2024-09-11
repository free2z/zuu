import { Helmet } from "react-helmet-async";
import {
    Grid,
} from "@mui/material"

import { useGlobalState } from "./state/global"
import DragDropFiles from "./components/DragDropFiles"
import { useEffect } from "react"


export default function ProfileUploads() {
    const [loginModal, setLoginModal] = useGlobalState("loginModal")
    const [authStatus, setAuthStatus] = useGlobalState("authStatus")

    useEffect(() => {
        setLoginModal(authStatus === false)
    }, [authStatus])

    if (!authStatus) return null

    return (
        <>
            <Helmet>
                <title>My Uploads - Free2Z</title>
            </Helmet>
            <Grid item xs={12}>
                <DragDropFiles />
            </Grid>
        </>
    )
}
