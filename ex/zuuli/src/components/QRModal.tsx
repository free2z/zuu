import * as React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Modal from '@mui/material/Modal';
import QRDisplay from './QRDisplay';

const style = {
    position: 'absolute' as 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width: "80%",
    minWidth: "200px",
    maxWidth: "600px",
    bgcolor: 'background.paper',
    border: '2px solid #000',
    boxShadow: 24,
    p: 4,
    wordWrap: "break-word"
};


interface QRModalProps {
    button: string
    title: string
    content: string
}

export default function QRModal(props: QRModalProps) {
    const [open, setOpen] = React.useState(false);
    const handleOpen = () => setOpen(true);
    const handleClose = () => setOpen(false);

    return (
        <div>
            <Button onClick={handleOpen}>{props.button}</Button>
            <Modal
                open={open}
                onClose={handleClose}
            >
                <QRDisplay addr={props.content} />
            </Modal>
        </div>
    );
}