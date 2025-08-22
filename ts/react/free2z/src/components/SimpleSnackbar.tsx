import React, { useEffect } from "react";
import { useSnackbar } from "notistack";
import { IconButton } from "@mui/material";
import { Close, ContentCopy } from "@mui/icons-material";
import { useGlobalState } from "../state/global";

export default function SimpleSnackbar() {
    const [snackbar, setSnackbar] = useGlobalState("snackbar");
    const { enqueueSnackbar, closeSnackbar } = useSnackbar();

    useEffect(() => {
        if (!snackbar.open) return;

        const handleCloseLocal = (key?: any) => {
            if (key !== undefined) closeSnackbar(key);
            setSnackbar({ ...snackbar, open: false });
        };

        const actionFactory = (key: any) => {
            const actions: React.ReactNode[] = [];
            const a = snackbar.action;
            const close = () => handleCloseLocal(key);

            // Optional custom action
            if (a) {
                if (typeof a.render === "function") {
                    actions.push(a.render({ key, close }));
                } else if (typeof a.onClick === "function") {
                    actions.push(
                        <IconButton
                            key="custom-action"
                            size="small"
                            aria-label={a.ariaLabel || "Action"}
                            onClick={async () => {
                                try {
                                    await a.onClick!();
                                } finally {
                                    close();
                                }
                            }}
                        >
                            {a.icon || <ContentCopy fontSize="small" />}
                        </IconButton>
                    );
                }
            }

            // Always include a close button (backwards compatible)
            actions.push(
                <IconButton
                    key="close"
                    onClick={() => handleCloseLocal(key)}
                    size="small"
                    aria-label="Close"
                >
                    <Close fontSize="small" />
                </IconButton>
            );

            return actions;
        };

        enqueueSnackbar(snackbar.message, {
            variant: snackbar.severity,
            autoHideDuration: snackbar.duration ?? undefined,
            anchorOrigin: { vertical: "bottom", horizontal: "center" },
            onClose: () => setSnackbar({ ...snackbar, open: false }),
            action: actionFactory,
            TransitionProps: {
                enter: true,
                exit: true,
                direction: "up",
                timeout: { enter: 300, exit: 500 },
            },
            style: { opacity: 0.9 },
        });
    }, [snackbar, enqueueSnackbar, closeSnackbar, setSnackbar]);

    return null;
}
