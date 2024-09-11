import { useLocation } from "react-router-dom"
import { Stack, useTheme } from "@mui/material"
import { PublicCreator } from "../CreatorDetail"
import { useGlobalState } from "../state/global"
import CreatorDonate from "./CreatorDonate"
import CreatorSubscribe from "./CreatorSubscribe"
import YouAreSubscribed from "./YouAreSubscribed"
import JoinLivestream from "./JoinLivesteam"
import ShareCreator from "./ShareCreator"
import { useEffect } from "react"
import { RecordVoiceOver } from "@mui/icons-material"
// import { useTransitionNavigate } from "../hooks/useTransitionNavigate"


export default function CreatorInteract(props: PublicCreator) {
    // console.log("PROPS", props)
    const theme = useTheme()
    // const navigate = useTransitionNavigate()
    const [currentUser, _scu] = useGlobalState("creator")
    const location = useLocation()

    // TODO: for now we just return the subs with the creator
    // data at
    // useEffect(() => {
    //     axios.get('/api/creator/subs').then((res) => {
    //         res.data.indexOf(props.username)
    //     })
    // }, [])
    // console.log("CURRENT", currentUser.username)
    // console.log("VIEWING", props.username)
    // The user is viewing their own profile
    const isSelf = (
        currentUser.username && props.username &&
        currentUser.username.toLowerCase() === props.username.toLowerCase()
    )

    const isProfile = (
        location.pathname === "/profile"
    )

    const is_subbed = currentUser.stars.indexOf(props.username) !== -1

    // useEffect(() => {
    //     console.log("ROOOOOOOOO")
    //     // console.log(currentUser, props, isSelf)
    //     console.log(isSelf, isProfile)
    // }, [])

    return (
        // <Grid item xs={12}>
        <Stack
            spacing={4}
            direction="row"
            justifyContent="center"
            alignItems="center"
            sx={{
                background: `${theme.palette.background.paper}`,
                margin: "0.25em",
            }}
        >
            {/* TODO: show link on public, non-self? */}
            {(isSelf && isProfile) && (
                <>

                </>
            )}

            {/* Public View */}
            {!isProfile &&
                <>
                    {/* <RecordVoiceOver /> */}
                    <CreatorDonate creator={props} />
                    {/* if no member_price, no subbing */}
                    {props.member_price &&
                        <>
                            {/* {
                                is_subbed ?
                                    <YouAreSubscribed {...props} />
                                    :
                                    <CreatorSubscribe {...props} />
                            } */}
                        </>
                    }
                    <ShareCreator {...props} />
                    <JoinLivestream {...props} />
                </>
            }
        </Stack>
        // </Grid >
    )
}