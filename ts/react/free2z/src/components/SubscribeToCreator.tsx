
import axios from "axios"
import { useTransitionNavigate } from "../hooks/useTransitionNavigate"

import {
    Button, Dialog, DialogActions, DialogContent, DialogContentText,
    DialogTitle, Stack, useMediaQuery,
} from "@mui/material"
import { PublicCreator } from "../CreatorDetail"
import { useGlobalState } from "../state/global"
import Tuzis from "./TuzisButton"
import LoginMessageStack from "./LoginMessageStack"
import { useLocation } from "react-router"
import { ReactNode } from "react"


type SubscribeToCreatorProps = {
    showPay: boolean,
    setShowPay: React.Dispatch<React.SetStateAction<boolean>>,
    // username: string,
    star: PublicCreator,
    nav?: boolean,
    memberPage?: string,
    onCloseClick?: () => void,
}

export const CreatorSubscribeContent = (props: SubscribeToCreatorProps) => {
    const { showPay, setShowPay, star } = props
    const [fan, setFan] = useGlobalState("creator")
    const setSnackbar = useGlobalState("snackbar")[1]

    const navigate = useTransitionNavigate()
    const location = useLocation()

    const isXS = useMediaQuery('(max-width: 310px)')

    return (
        <>
            {/* <DialogTitle id="responsive-dialog-title">
                Subscribe to {star.full_name || star.username}
            </DialogTitle> */}
            <DialogContent>
                <DialogContentText>
                    For {star.member_price} 2Zs per month,
                    support {star.full_name || star.username} and
                    get access to livestreams and other members-only
                    content.
                </DialogContentText>
                {fan.username ? (
                    <>
                        <DialogContentText>
                            You have {Number(fan.tuzis).toFixed(0)} 2Zs
                        </DialogContentText>
                        <Stack
                            direction="row"
                            alignItems="center"
                            justifyContent="center"
                        >
                            <Tuzis {...fan} />
                        </Stack>
                    </>
                ) : (
                    <LoginMessageStack
                        message={"Log in to subscribe"}
                    />
                )}
            </DialogContent>
            <DialogActions
                style={{
                    padding: "1em",
                }}
            >
                <Button
                    color="warning"
                    onClick={props.onCloseClick || (() => {
                        // console.log("Close modal from exit button")
                        props.setShowPay(false)

                        if (location.pathname !== `/${star.username}`) {
                            navigate(-1);
                        }
                    })}
                >Close</Button>
                {fan.username && Number(fan.tuzis) >= Number(star.member_price) && (
                    <Button
                        variant="contained"
                        color="success"
                        onClick={() => {
                            axios.post(
                                `/api/tuzis/subscribe/${star.username}`, {}, {
                            }).then((res) => {
                                // console.log("SUBSCRIBED", res)
                                // Set the subscriber state
                                // setFan(creator)
                                axios
                                    .get("/api/auth/user/")
                                    .then((res) => {
                                        // console.log("[GET auth/user] subscribe to creator")
                                        setFan(res.data)
                                    })
                                // console.log("close modal after button click")
                                props.setShowPay(false)
                                setSnackbar({
                                    open: true,
                                    message: `Successfully subscribed to ${star.full_name || star.username}`,
                                    severity: "success",
                                    duration: null,
                                })
                                if (props.memberPage) {
                                    // redirect to a specific page after subscribing
                                    navigate(`${props.memberPage}`)
                                }

                            }).catch((res) => {
                                // console.log("CATCH", err)
                                setSnackbar({
                                    message: res.data.error,
                                    open: true,
                                    duration: undefined,
                                    severity: "error",
                                })

                            })
                        }}
                    >SUBSCRIBE
                    </Button>
                )}
            </DialogActions>
        </>
    )
};

export default function SubscribeToCreator(props: SubscribeToCreatorProps & { children?: ReactNode }) {
    const { showPay, setShowPay, star, children } = props
    const [fan, setFan] = useGlobalState("creator")
    const setSnackbar = useGlobalState("snackbar")[1]

    const navigate = useTransitionNavigate()
    const location = useLocation()

    const isXS = useMediaQuery('(max-width: 310px)')

    return (
        <Dialog
            fullScreen={isXS}
            fullWidth
            maxWidth="sm"
            open={showPay}
            onClose={() => {
                // TODO: non-happy cases
                // console.log("Close modal from dialog 'non-happy' cases")
                setShowPay(false)
            }}
            aria-labelledby="responsive-dialog-title"
        >
            {children || (
                <CreatorSubscribeContent {...props} />
            )}
        </Dialog >
    )
}
