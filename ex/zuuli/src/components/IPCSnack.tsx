import * as React from 'react';
import Button from '@mui/material/Button';
import Snackbar from '@mui/material/Snackbar';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import MuiAlert, { AlertProps } from '@mui/material/Alert';
import { ipc } from '../db/db';

// import { ipcRenderer } from 'electron';


const Alert = React.forwardRef<HTMLDivElement, AlertProps>(function Alert(
    props,
    ref,
) {
    return <MuiAlert elevation={6} ref={ref} variant="filled" {...props} />;
});

interface SnackMessage {
    message: string
    severity: "success" | "error" | "info" | "warning"
}

export default function SimpleSnackbar() {
    const [open, setOpen] = React.useState(false)
    const [message, setMessage] = React.useState("hello")
    const [severity, setSeverity] = React.useState('success' as 'success' | 'info' | 'warning' | 'error')

    // TODO: TYPE
    // TODO: register only once?
    console.log("REGISTER SNACKBAR")
    ipc.onIPCSnackbar((event: any, sm: SnackMessage) => {
        console.log("IPCSNACK", event, sm)
        setMessage(sm.message)
        setSeverity(sm.severity)
        setOpen(true)
    })

    const handleClose = (event: React.SyntheticEvent | Event, reason?: string) => {
        setOpen(false);
    };

    return (
        <Snackbar
            open={open}
            // autoHideDuration={6000}
            onClose={handleClose}
        >
            <Alert
                onClose={handleClose}
                severity={severity}
                sx={{ width: '100%' }}
            >
                {message}
            </Alert>
        </Snackbar>
    );
}
