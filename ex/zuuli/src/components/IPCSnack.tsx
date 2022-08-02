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



export default function SimpleSnackbar() {
    const [open, setOpen] = React.useState(false)
    const [message, setMessage] = React.useState("")
    const [severity, setSeverity] = React.useState('success' as 'success' | 'info' | 'warning' | 'error')

    // TODO: TYPE
    // TODO: register only once
    ipc.onIPCSnackbar((event: any, arg: any) => {
        console.log("IPCSNACK", event, arg)
    })

    // ipcRenderer.on('cancel-sync-reply', (event, arg) => {
    //     console.log(arg)
    //     setSeverity("info")
    //     setMessage("canceled")
    //     setOpen(true)
    // })


    const handleClose = (event: React.SyntheticEvent | Event, reason?: string) => {
        setOpen(false);
    };

    // const action = (
    //     <React.Fragment>
    //         <Button color="secondary" size="small" onClick={handleClose}>
    //             UNDO
    //         </Button>
    //         <IconButton
    //             size="small"
    //             aria-label="close"
    //             color="inherit"
    //             onClick={handleClose}
    //         >
    //             <CloseIcon fontSize="small" />
    //         </IconButton>
    //     </React.Fragment>
    // );

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
        // <Snackbar
        //     open={open}
        //     // autoHideDuration={6000}
        //     onClose={handleClose}
        //     message={message}
        // // action={action}
        // />
    );
}

