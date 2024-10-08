import { useEffect } from "react";
import { useSnackbar } from 'notistack';
import { Fade, IconButton } from "@mui/material";
import { Close } from "@mui/icons-material";

import { useGlobalState } from "../state/global"

export default function SimpleSnackbar() {
    const [snackbar, setSnackbar] = useGlobalState("snackbar")
    const { enqueueSnackbar, closeSnackbar } = useSnackbar();

    useEffect(() => {
        // console.log("snackbar", snackbar)
        if (snackbar.open) {
            // Enqueue a snackbar
            enqueueSnackbar(snackbar.message, {
                variant: snackbar.severity,
                autoHideDuration: snackbar.duration,
                anchorOrigin: {
                    vertical: 'bottom',
                    horizontal: 'center',
                },
                onClose: () => setSnackbar({ ...snackbar, open: false }),
                action: key => (
                    <IconButton
                        onClick={() => {
                            closeSnackbar(key);
                            setSnackbar({ ...snackbar, open: false });
                        }}
                        size="small"
                    >
                        <Close fontSize="small" />
                    </IconButton>
                ),
                TransitionProps: {
                    enter: true,
                    exit: true,
                    direction: 'up',
                    timeout: {
                        enter: 300,  // Fade in duration
                        exit: 500,  // Fade out duration
                    },
                },
                style: {
                    opacity: 0.9,
                },
            });
        }
    }, [snackbar]);

    return null; // You don't need to return anything from this component anymore
}
