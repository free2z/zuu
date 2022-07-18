import * as React from 'react';
import Box from '@mui/material/Box';
import { IconButton } from '@mui/material';
import Typography from '@mui/material/Typography';
import Modal from '@mui/material/Modal';

import { HelpCenter } from "@mui/icons-material"


const style = {
    position: 'absolute' as 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width: '270px',
    bgcolor: 'background.paper',
    border: '2px solid #000',
    boxShadow: 24,
    p: 4,
};

export default function NewOrRestoreModal() {
    const [open, setOpen] = React.useState(false);
    const handleOpen = () => setOpen(true);
    const handleClose = () => setOpen(false);

    return (
        <div>
            <IconButton onClick={handleOpen}>
                <HelpCenter color="info" />
            </IconButton>
            <Modal
                open={open}
                onClose={handleClose}
                aria-labelledby="modal-modal-title"
                aria-describedby="modal-modal-description"
            >
                <Box sx={style}>
                    <Typography
                        id="modal-modal-title" variant="h6" component="h2"
                        color="info"
                    >
                        New or Restore
                    </Typography>
                    <Typography id="modal-modal-description" sx={{ mt: 2 }}>
                        Input a seed phrase and height to restore or click "New"
                        to create a new wallet.
                    </Typography>
                    <Typography color="secondary" sx={{ mt: 2 }}>
                        Always keep your secret phrase safe and you will
                        be able to access your funds!
                        Your funds do not go with the device,
                        they go with your secret phrase!
                    </Typography>
                </Box>
            </Modal>
        </div>
    );
}
