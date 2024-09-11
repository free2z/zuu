import { Dialog, DialogContent, Typography, Box, DialogActions, Theme, useMediaQuery, Button, Stack } from "@mui/material";
import TuzisMenuItem from "./TuzisMenuItem";
import { useState } from "react";
import { useGlobalState } from "../state/global";


type NeedTuziDialogProps = {
    goBackOnClose?: boolean
    // startOpen: boolean
}

export default function NeedTuziDialog(props: NeedTuziDialogProps) {
    const { goBackOnClose } = props
    const [creator, setCreator] = useGlobalState("creator")
    const [open, setOpen] = useState(true)
    const fullScreen = useMediaQuery((theme: Theme) => theme.breakpoints.down('sm'));

    function onClose() {
        setOpen(false)
        if (goBackOnClose) {
            window.history.back()
        }
    }

    return (
        <Dialog open={open} onClose={onClose}
            maxWidth="sm"
            fullWidth
            fullScreen={fullScreen}
        >
            <DialogContent>
                <Stack direction="column" spacing={2} alignItems="center">
                    <Typography variant="h6" component="div" sx={{ textAlign: 'center' }}>
                        You need 150 tuzis!!
                    </Typography>

                    <Typography variant="caption" component="div" sx={{ textAlign: 'center' }}>
                        You currently have {Number(creator.tuzis).toFixed(0)} tuzis.
                    </Typography>
                    <TuzisMenuItem {...creator} />
                </Stack>
            </DialogContent>

            <DialogActions>
                <Button onClick={onClose}>
                    Close
                </Button>
            </DialogActions>
        </Dialog>
    )
}