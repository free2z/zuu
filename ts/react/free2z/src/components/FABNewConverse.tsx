import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import Fab from '@mui/material/Fab';
import AddIcon from '@mui/icons-material/Add';
import { useState } from 'react';
import CommentForm from './CommentForm';
import { DialogActions, Button } from '@mui/material';
import { useGlobalState } from '../state/global';


export default function FABNewConverse() {
    const [open, setOpen] = useState(false);
    const [creator, setCreator] = useGlobalState("creator")
    const theme = useTheme();
    const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));

    const handleOpen = () => {
        setOpen(true);
    };

    const handleClose = () => {
        setOpen(false);
    };

    // console.log("FABNewConverse")

    return (
        <>
            {/* Floating Action Button */}
            <Fab color="primary" aria-label="add" onClick={handleOpen}
                style={{
                    position: "fixed",
                    right: "7%",
                    // top: "8%",
                    bottom: "5%",
                    opacity: 0.9,
                }}

            >
                <AddIcon />
            </Fab>

            {/* Dialog */}
            <Dialog
                fullScreen={fullScreen}
                open={open}
                onClose={handleClose}
                fullWidth
                maxWidth={creator.username ? "md" : "sm"}
            >
                <DialogTitle>F2Z Converse</DialogTitle>
                <DialogContent>
                    <CommentForm callback={handleClose}
                        height={window.innerHeight * 0.5}
                    />
                </DialogContent>
                <DialogActions>
                    <Button onClick={handleClose}>Cancel</Button>
                </DialogActions>
            </Dialog>
        </>
    );
}
