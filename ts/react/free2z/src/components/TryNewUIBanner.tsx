import { useState } from "react"

import { Button, IconButton, Snackbar } from "@mui/material"
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome"
import CloseIcon from "@mui/icons-material/Close"

// Bump the version suffix to re-show the banner to users who dismissed it.
const DISMISSED_KEY = "f2z-try-new-ui-banner-dismissed-v1"

// The /try-new-ui switch route only exists where nginx serves both UIs.
const SWITCH_HOSTS = /(^|\.)(free2z\.cash|free2z\.com|free2give\.xyz)$/

export default function TryNewUIBanner() {
    const [open, setOpen] = useState(() =>
        SWITCH_HOSTS.test(window.location.hostname) &&
        !localStorage.getItem(DISMISSED_KEY)
    )

    const dismiss = () => {
        localStorage.setItem(DISMISSED_KEY, new Date().toISOString())
        setOpen(false)
    }

    return (
        <Snackbar
            open={open}
            anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
            message="Try the new Free2z experience"
            action={
                <>
                    <Button
                        // Full page load on purpose: /try-new-ui is an nginx
                        // route that sets the UI cookie and redirects to /.
                        href="/try-new-ui"
                        color="primary"
                        size="small"
                        startIcon={<AutoAwesomeIcon />}
                    >
                        Try it
                    </Button>
                    <IconButton
                        size="small"
                        aria-label="dismiss"
                        color="inherit"
                        onClick={dismiss}
                    >
                        <CloseIcon fontSize="small" />
                    </IconButton>
                </>
            }
        />
    )
}
