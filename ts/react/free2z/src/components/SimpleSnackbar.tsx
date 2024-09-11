import { useEffect } from "react";
import { useSnackbar } from 'notistack';
import { IconButton } from "@mui/material";
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
            });
        }
    }, [snackbar]);

    return null; // You don't need to return anything from this component anymore
}
