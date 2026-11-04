import { Helmet } from "react-helmet-async";
import { useEffect, useState } from "react"
import { useLocation, useNavigate, useParams } from "react-router"

import axios from "axios"
import { AlertColor } from "@mui/material"

import PageRenderer, { PageInterface } from "./components/PageRenderer"
import { useGlobalState } from "./state/global"
import { Tag } from "./components/TagFilterMultiSelect"
import SubscribeToCreator from "./components/SubscribeToCreator"
import { resolveClassicPageOwner } from "./classicRouteCompatibility"

export interface PageComment {
    created_at: string
    comment: string
}

export default function PageDetail({
    identifier,
    expectedCreator,
}: {
    identifier?: string,
    expectedCreator?: string,
} = {}) {
    const setSnackbarState = useGlobalState("snackbar")[1]
    const [loading, setLoading] = useGlobalState("loading")
    const [modalOpen, setModalOpen] = useState(false)
    const [authStatus, setAuthStatus] = useGlobalState("authStatus")
    const navigate = useNavigate()
    const location = useLocation()

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
    const [loadedPageIdentifier, setLoadedPageIdentifier] = useState<
        string | undefined
    >()

    const params = useParams()
    const pageIdentifier = identifier || params.id
    // React Router decodes route parameters. Encode the value again before
    // interpolation so `/article/..%2Ftwitter%2Fstart%23` cannot normalize the
    // credentialed axios request into a different same-origin API endpoint.
    const encodedPageIdentifier = encodeURIComponent(pageIdentifier || "")

    useEffect(() => {
        // Route transitions reuse this component. Mark the effect inactive in
        // cleanup so a slower response for the previous identifier cannot
        // overwrite the current page (including its real-money controls).
        let active = true
        if (!modalOpen) {
            setLoading(true)
        }
        axios
            .get(`/api/zpage/${encodedPageIdentifier}/`)
            .then((res) => {
                if (!active) return
                const resolvedPage = res.data.show_modal ? res.data.page : res.data
                const ownerResolution = resolveClassicPageOwner(
                    expectedCreator,
                    resolvedPage,
                )
                if (ownerResolution.status === "unverifiable") {
                    throw new Error("Page response did not identify its canonical owner")
                }
                if (ownerResolution.status === "redirect") {
                    // Do not set page/modal state first: the page renderer carries
                    // funding controls, so mismatched content must never mount under
                    // the requested creator's trusted URL.
                    setLoading(false)
                    navigate(
                        `${ownerResolution.path}${location.search}${location.hash}`,
                        { replace: true },
                    )
                    return
                }
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
                    setLoadedPageIdentifier(pageIdentifier)
                    // }
                } else {
                    setPage({
                        ...res.data,
                        tags: res.data.tags.map((t: string) => {
                            return { name: t }
                        })
                    })
                    setLoadedPageIdentifier(pageIdentifier)
                    // console.log("closing modal from detail")
                    setModalOpen(false)
                }
                // window.scrollTo(0, 0)
                setLoading(false)
            })
            .catch((res) => {
                if (!active) return
                setSnackbarState({
                    open: true,
                    severity: "error" as AlertColor,
                    message: JSON.stringify(res),
                    duration: null,
                })
                setLoading(false)
            })

        return () => {
            active = false
        }
    }, [
        modalOpen,
        pageIdentifier,
        encodedPageIdentifier,
        authStatus,
        expectedCreator,
        location.hash,
        location.search,
        navigate,
        setLoading,
        setSnackbarState,
    ])

    // A route transition can reuse this component while its next request is in
    // flight. Bind rendered state to the exact identifier that produced it so
    // a failed same-creator transition cannot leave the previous page's money
    // controls mounted under the new URL.
    if (loadedPageIdentifier !== pageIdentifier) return null

    // Keep any previously loaded page out of a different creator's namespace
    // as well as rejecting a mismatched response before setPage().
    if (
        expectedCreator &&
        resolveClassicPageOwner(expectedCreator, page).status !== "verified"
    ) return null

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
