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
    const params = useParams();
    const owner = params.owner;
    const uuid = params.uuid;

    const [creator] = useGlobalState("creator");
    const setSnackbarState = useGlobalState("snackbar")[1];
    const [loading, setLoading] = useGlobalState("loading");
    const [authStatus] = useGlobalState("authStatus");

    const navigate = useTransitionNavigate();
    const [meeting, initMeeting] = useDyteClient();

    const [clipboardPending, setClipboardPending] = useState(false);

    // --- Helpers ----------------------------------------------------

    const showManualCopySnackbar = () => {
        const url = window.location.href;

        setSnackbarState({
            message: "Tap the copy icon to copy your secret URL.",
            severity: "info",
            duration: null,
            open: true,
            action: {
                ariaLabel: "Copy link",
                onClick: async () => {
                    try {
                        await navigator.clipboard.writeText(url);
                        setSnackbarState({
                            message: "Link copied.",
                            severity: "success",
                            duration: 3000,
                            open: true,
                        });
                    } catch {
                        // Last-ditch: just show the raw URL so they can select/copy.
                        setSnackbarState({
                            message: url,
                            severity: "info",
                            duration: null,
                            open: true,
                        });
                    }
                },
            },
        });
    };

    const copyToClipboard = async (): Promise<boolean> => {
        const url = window.location.href;
        try {
            if (
                !window.isSecureContext || // some browsers require secure context
                !navigator.clipboard ||
                typeof navigator.clipboard.writeText !== "function"
            ) {
                showManualCopySnackbar();
                return false;
            }
            await navigator.clipboard.writeText(url);
            setSnackbarState({
                message:
                    "Secret URL copied to clipboard. Share it only with people you want to join the call.",
                severity: "success",
                duration: null,
                open: true,
            });
            return true;
        } catch {
            // Swallow Safari/permission errors and show fallback
            showManualCopySnackbar();
            return false;
        }
    };

    // When window regains focus (after meeting init), try to copy; on failure show fallback snackbar
    useEffect(() => {
        if (!clipboardPending) return;

        const handleFocus = async () => {
            setClipboardPending(false);
            await copyToClipboard(); // fallback snackbar shown internally if it fails
        };

        // Attach once to avoid stacking handlers
        window.addEventListener("focus", handleFocus, { once: true });
        return () => window.removeEventListener("focus", handleFocus);
    }, [clipboardPending]);

    // --- Init flow --------------------------------------------------

    useEffect(() => {
        if (authStatus === null) return;

        const is_owner = creator.username.toLowerCase() === owner?.toLowerCase();

        if (!creator.can_stream && is_owner) {
            setSnackbarState({
                message: "You need 150 tuzis to go live",
                severity: "warning",
                duration: undefined,
                open: true,
            });
            navigate("/profile");
            return;
        }

        setSnackbarState({
            message: "Please wait while the meeting initializes",
            severity: "info",
            duration: undefined,
            open: true,
        });
        setLoading(true);

        axios
            .post(`/api/dyte/${owner}/private/${uuid}`)
            .then((res) =>
                initMeeting({
                    authToken: res.data.auth_token,
                    // modules: { e2ee: { enabled: true, manager: e2eeManager } }
                })
            )
            .then(async () => {
                setLoading(false);

                if (is_owner) {
                    if (document.hasFocus()) {
                        await copyToClipboard(); // fallback snackbar shown internally if it fails
                    } else {
                        setClipboardPending(true);
                        // Optional: show the manual-copy snackbar proactively so users see it immediately
                        showManualCopySnackbar();
                    }
                }
            })
            .catch((err) => {
                console.error("catch*********", err);
                setSnackbarState({
                    message: "Error initializing meeting",
                    severity: "error",
                    duration: undefined,
                    open: true,
                });
                setLoading(false);
                navigate(`/${owner}`);
            });
    }, [creator.username, authStatus]);

    return (
        <>
            <Helmet>
                <title>{`Private Call`}</title>
            </Helmet>
            <DyteProvider value={meeting} fallback={<></>}>
                <DyteLeave />
                <DyteCreator />
            </DyteProvider>
        </>
    );
}
