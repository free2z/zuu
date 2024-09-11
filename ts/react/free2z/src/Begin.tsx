// TODO: I think we get rid of this someday
import { useEffect } from "react"
import axios from "axios"
import { Grid } from "@mui/material"

import CreatorLoginModal from "./CreatorLoginModal"
import { PublicCreator } from "./CreatorDetail"
import { useGlobalState } from "./state/global"
import { useTransitionNavigate } from "./hooks/useTransitionNavigate"

export interface TwitterProfile {
    id: string,
    name: string,
    username: string,
}

export interface Creator extends PublicCreator {
    // username: string
    // email: string
    // p2paddr: string
    // first_name: string
    // last_name: string
    // total: number
    // zpages: number
    updateAll: boolean
    tuzis: string
    fans: string[]
    stars: string[]
    twitter?: TwitterProfile
    // full_name: string
    // description: string
    // member_price: string
}

function Begin() {
    const navigate = useTransitionNavigate()
    const [_, setLoading] = useGlobalState("loading")
    const [creator, setCreator] = useGlobalState("creator")
    const [redirect, setRedirect] = useGlobalState("redirect")
    const [loginModal, setLoginModal] = useGlobalState("loginModal")
    const [authStatus, setAuthStatus] = useGlobalState("authStatus")

    useEffect(() => {
        // console.log("BEGIN authstatus null")
        setAuthStatus(null)
        setLoading(true)
        setLoginModal(!creator.username)
        axios
            .get("/api/auth/user/")
            .then((res) => {
                // console.log("[get auth/user] BEGIN authstatus true")
                setCreator(res.data)
                setAuthStatus(true)
                setLoginModal(false)
                setLoading(false)
                if (redirect) {
                    navigate(redirect)
                } else {
                    navigate("/profile")
                }
            })
            .catch((res) => {
                // console.log("BEGIN authstatus catch false")
                setAuthStatus(false)
                setLoading(false)
            })
    }, [])

    return (
        <Grid
            container
            spacing={0}
            direction="column"
            alignItems="center"
            textAlign="center"
            justifyContent="center"
            style={{ minHeight: "100vh" }}
        >
            <CreatorLoginModal />
        </Grid>
    )
}

export default Begin
