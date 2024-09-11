import { Helmet } from "react-helmet-async";
import { useDyteClient, DyteProvider } from "@dytesdk/react-web-core";
// import { DyteE2EEManager } from '@dytesdk/web-core/modules/e2ee';

import axios from "axios";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useTransitionNavigate } from "./hooks/useTransitionNavigate";
import DyteLeave from "./components/DyteLeave";
import DyteCreator from "./components/DyteCreator";
import { useGlobalState } from "./state/global";


export default function CreatorLive() {
    const params = useParams()
    const owner = params.owner
    const uuid = params.uuid

    const [creator, _c] = useGlobalState("creator")
    const setSnackbarState = useGlobalState("snackbar")[1]
    const [loading, setLoading] = useGlobalState("loading")
    const [authStatus, _a] = useGlobalState("authStatus")

    const navigate = useTransitionNavigate()
    const [meeting, initMeeting] = useDyteClient()

    const [clipboardPending, setClipboardPending] = useState(false);

    const copyToClipboard = async () => {
        await navigator.clipboard.writeText(window.location.href);
        setSnackbarState({
            message: `Secret URL copied to clipboard. Share it only with people you want to join the call.`,
            severity: "success",
            duration: null,
            open: true,
        });
    };

    useEffect(() => {
        const handleFocus = async () => {
            if (clipboardPending) {
                setClipboardPending(false);
                await copyToClipboard();
                document.removeEventListener('focus', handleFocus);
            }
        };

        document.addEventListener('focus', handleFocus);

        return () => {
            document.removeEventListener('focus', handleFocus);
        };
    }, [clipboardPending]);

    useEffect(() => {
        console.log("Starting Private", creator.username)

        if (authStatus === null) {
            console.log("authStatus is null")
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

        setSnackbarState({
            message: "Please wait while the meeting initializes",
            severity: "info",
            duration: undefined,
            open: true,
        })
        setLoading(true)
        axios.post(`/api/dyte/${owner}/private/${uuid}`).then((res) => {

            // console.log("INIT MEETING", res)

            // TODO: e2ee
            // const sharedKeyProvider = new DyteE2EEManager.SharedKeyProvider();
            // sharedKeyProvider.setKey("meeting-password");
            // const e2eeManager = new DyteE2EEManager({ keyProvider: sharedKeyProvider });

            initMeeting({
                authToken: res.data.auth_token,
                // https://dyte.io/blog/end-to-end-encryption/
                // modules: {
                //     e2ee: {
                //         enabled: true,
                //         manager: e2eeManager,
                //     }
                // }
            }).then(async (client) => {
                setLoading(false);

                if (is_owner) {
                    if (document.hasFocus()) {
                        await copyToClipboard();
                    } else {
                        setClipboardPending(true);
                    }
                }
            }).catch((err) => {
                console.error("catch*********", err)
                // window.location.reload()
                setSnackbarState({
                    message: "Error initializing meeting",
                    severity: "error",
                    duration: undefined,
                    open: true,
                });
                setLoading(false);
                navigate(`/${owner}`)
            });
        }).catch((reason) => {
            setLoading(false)
            console.log("FAIL1", reason)
            setSnackbarState({
                message: "Error initializing meeting",
                severity: "error",
                duration: undefined,
                open: true,
            });
            navigate(`/${owner}`)
        })
    }, [creator.username, authStatus])

    return (
        <>
            <Helmet>
                <title>{`Private Call`}</title>
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
