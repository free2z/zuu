import { Helmet } from "react-helmet-async";
import { useEffect, useState } from "react"
import { useParams } from "react-router"

import axios from "axios"
import { AlertColor } from "@mui/material"

import PageRenderer, { PageInterface } from "./components/PageRenderer"
import { useGlobalState } from "./state/global"
import { Tag } from "./components/TagFilterMultiSelect"
import SubscribeToCreator from "./components/SubscribeToCreator"

export interface PageComment {
    created_at: string
    comment: string
}

export default function PageDetail() {
    const setSnackbarState = useGlobalState("snackbar")[1]
    const [loading, setLoading] = useGlobalState("loading")
    const [modalOpen, setModalOpen] = useState(false)
    const [authStatus, setAuthStatus] = useGlobalState("authStatus")

    const [page, setPage] = useState({
        title: "",
        content: `


        `,
        // category: "",
        tags: [] as Tag[],
        free2zaddr: "",
        p2paddr: "",
        vanity: "",
        is_published: true,
        is_verified: false,
        is_subscriber_only: false,
        creator: {},
        total: "42",
        f2z_score: "42",
        created_at: Date(),
        updated_at: Date(),
        comments: Array<PageComment>(),
    } as PageInterface)

    const params = useParams()

    useEffect(() => {
        if (!modalOpen) {
            setLoading(true)
        }
        axios
            .get(`/api/zpage/${params.id}/`)
            .then((res) => {
                if (res.data.show_modal) {
                    const updatedContentPage = {
                        ...res.data.page,
                        content: "Subscribe for access to this exclusive content!"
                    }
                    // TODO: this is some janky stuff here.
                    // Flashes the subscribe even if we're already subscribed..
                    // Only show the pay modal if we're really logged in
                    // if (authStatus !== null) {
                    // console.log("opening modal from detail", authStatus)
                    setModalOpen(true)
                    setPage({
                        ...updatedContentPage,
                        tags: res.data.page.tags.map((t: string) => {
                            return { name: t }
                        })
                    })
                    // }
                } else {
                    setPage({
                        ...res.data,
                        tags: res.data.tags.map((t: string) => {
                            return { name: t }
                        })
                    })
                    // console.log("closing modal from detail")
                    setModalOpen(false)
                }
                // window.scrollTo(0, 0)
                setLoading(false)
            })
            .catch((res) => {
                setSnackbarState({
                    open: true,
                    severity: "error" as AlertColor,
                    message: JSON.stringify(res),
                    duration: null,
                })
                setLoading(false)
            })
    }, [modalOpen, params.id, authStatus])

    if (!page.title) return null

    return (
        <>
            <Helmet>
                <title>{page.title} - Free2Z</title>
                <meta name="description" content={page.description || page.content.substring(0, 150)} />
                <meta name="author" content={page.creator.full_name || page.creator.username} />
                <meta name="keywords" content={page.tags.map((t) => t.name).join(", ")} />
            </Helmet>
            <SubscribeToCreator
                showPay={modalOpen}
                setShowPay={setModalOpen}
                star={page.creator}
                memberPage={page.get_url} />
            <PageRenderer page={page} />
        </>
    )
}
