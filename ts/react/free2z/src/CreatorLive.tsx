import { Helmet } from "react-helmet-async";
import { useDyteClient, DyteProvider } from "@dytesdk/react-web-core";
import axios from "axios";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useTransitionNavigate } from "./hooks/useTransitionNavigate";
import DyteLeave from "./components/DyteLeave";
import DyteCreator from "./components/DyteCreator";
import SubscribeToCreator from "./components/SubscribeToCreator";
import { PublicCreator } from "./CreatorDetail";
import { useGlobalState } from "./state/global";
import { useStoreState } from "./state/persist";


export default function CreatorLive() {
    const params = useParams()
    const owner = params.id
    const type = params.type?.toLowerCase()
    const ppvPrice = useStoreState("ppvPrice")
    const [creator, _c] = useGlobalState("creator")
    const setSnackbarState = useGlobalState("snackbar")[1]
    const [loading, setLoading] = useGlobalState("loading")
    const [loginModal, setLoginModal] = useGlobalState("loginModal")
    const [authStatus, _a] = useGlobalState("authStatus")
    const navigate = useTransitionNavigate()
    const [meeting, initMeeting] = useDyteClient()
    const [showPay, setShowPay] = useState(false)
    const [star, setStar] = useState({} as PublicCreator)

    useEffect(() => {
        axios.get(`/api/creator/${owner}/`).then((res) => {
            setStar(res.data)
        }).catch((res) => {
            setSnackbarState({
                message: `Failed to get creator ${owner}`,
                severity: "error",
                duration: undefined,
                open: true,
            })
        })
    }, [])

    useEffect(() => {
        // console.log("CreatorLive useEffect", authStatus, creator.username, owner, type)
        if (authStatus === false) {
            setLoading(false)
            // users can join public broadcasts without logging in
            if (type !== "broadcast") {
                setLoginModal(true)
                return
            }
        }
        setLoginModal(false)

        if (!star.username) {
            return
        }

        if (!creator.username && type !== "broadcast") {
            // console.log("no creator return NULL", creator.username, type)
            setLoginModal(true)
            return
        }

        const is_owner = creator.username.toLowerCase() === owner?.toLowerCase()
        if (!creator.can_stream && is_owner) {
            setSnackbarState({
                message: "You need 150 tuzis to go live",
                severity: "warning",
                duration: undefined,
                open: true,
            })
            navigate('/profile')
            return
        }

        if (!showPay) {
            setSnackbarState({
                message: "Please wait while the meeting initializes",
                severity: "info",
                duration: undefined,
                open: true,
            })
            setLoading(true)
        }

        let body = {}
        if (type === "ppv" && is_owner) {
            body = {
                price_per_minute: ppvPrice,
            }
        }

        axios.post(`/api/dyte/${owner}/${type}`, body).then((res) => {
            // console.log("INIT MEETING", res)
            initMeeting({
                authToken: res.data.auth_token,
            }).then((client) => {
                setSnackbarState({
                    message: "Thanks for joining",
                    severity: "info",
                    duration: undefined,
                    open: true,
                })
                setLoading(false)
            }).catch((err) => {
                // console.error("catch", err)
                window.location.reload()
            });

        }).catch((reason) => {
            setLoading(false)
            // console.log("FAIL1", reason)
            if (reason.status === 402) {
                // must be subscribed
                if (type === "subscribers-only") {
                    setShowPay(true)
                    return
                }
                if (type === "ppv") {
                    setSnackbarState({
                        message: `${reason.data}`,
                        severity: "warning",
                        duration: null,
                        open: true,
                    })
                    navigate(`/${star.username}`)
                    return
                }
            }
            if (reason.status === 412 || reason.status === 404) {
                setSnackbarState({
                    message: "Creator is not live!",
                    severity: "error",
                    duration: null,
                    open: true,
                })
                navigate(`/${star.username}`)
                return
            }
        })
    }, [creator.username, showPay, star.username])

    // console.log(owner)
    if (!star) {
        // console.log("no star")
        return null
    }
    // console.log("render CreatorLive", showPay, owner)
    // sth with the 100% maybe?
    if (showPay) {
        // console.log("render subscribetocreator")
        setLoading(false)
        return (
            <>
                <SubscribeToCreator
                    star={star}
                    showPay={showPay}
                    setShowPay={setShowPay}
                    nav={true} />
            </>
        )
    }
    // Only broadcast type allows unauthenticated users to join
    if (!creator.username && type !== "broadcast") {
        return null
    }

    return (
        <>
            <Helmet>
                <title>{`${star.username}'s Live Stream - Free2Z`}</title>
            </Helmet>
            <DyteProvider
                value={meeting}
                fallback={<></>}
            >
                <DyteLeave />
                <DyteCreator />
            </DyteProvider>
        </>
    );
}
