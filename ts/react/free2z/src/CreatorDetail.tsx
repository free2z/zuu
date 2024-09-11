import { useEffect, useState } from "react"
import { useParams } from "react-router"
import { AlertColor } from "@mui/material"
import { Helmet } from "react-helmet-async";
import axios from "axios"

import { FeaturedImage } from "./components/PageRenderer"
import DisplayCreator from "./components/DisplayCreator"
import { useGlobalState } from "./state/global"


export interface PublicCreator {
    username: string
    is_verified: boolean
    total: number
    full_name: string
    description: string
    p2paddr: string
    zpages: number
    member_price: string
    can_stream: boolean
    avatar_image: FeaturedImage | null
    banner_image: FeaturedImage | null
}


export default function CreatorDetail() {
    const [loading, setLoading] = useGlobalState("loading")
    const [_, setSnackbarState] = useGlobalState("snackbar")

    const [creator, setCreator] = useState({
        username: "",
        is_verified: false,
        total: 0,
        zpages: 0,
    } as PublicCreator)

    const params = useParams()

    useEffect(() => {
        setLoading(true)
        axios
            .get(`/api/creator/${params.id}/`)
            .then((res) => {
                setCreator(res.data)
                setLoading(false)
            })
            .catch((res) => {
                setSnackbarState({
                    open: true,
                    severity: "error" as AlertColor,
                    message: JSON.stringify(res.data),
                    duration: null,
                })
                setLoading(false)
            })
    }, [params.id])

    if (!creator.username) {
        return null
    }

    return (
        <>
            <Helmet>
                <title>{creator.username} on Free2Z</title>
                <meta name="description" content={creator.description} />
                <link
                    rel="alternate"
                    type="application/rss+xml"
                    title={`${creator.username} zPages Feed`}
                    href={`/feeds/${creator.username}/zpages/recent.xml`}
                />
                <link
                    rel="alternate"
                    type="application/rss+xml"
                    title={`${creator.username} Converse Feed`}
                    href={`/feeds/${creator.username}/converse/recent.xml`}
                />
                <link
                    rel="alternate"
                    type="application/rss+xml"
                    title={`${creator.username} AI Feed`}
                    href={`/feeds/${creator.username}/ai/recent.xml`}
                />
                <link
                    rel="alternate"
                    type="application/rss+xml"
                    title={`${creator.username} Podcasts Feed`}
                    href={`/feeds/${creator.username}/podcasts/recent.xml`}
                />
            </Helmet>

            <DisplayCreator {...creator} /></>
    )
}
