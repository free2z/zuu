import React from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, Typography, useMediaQuery } from '@mui/material';
import { PageInterface } from './PageRenderer';
import BoostForm from './BoostForm'; // Component for handling the POST boost

interface BoostPageDialogProps {
    page: PageInterface;
    setPage: React.Dispatch<React.SetStateAction<PageInterface>>;
    open: boolean;
    onClose: () => void;
}

// Boosting is a 2Z action. The Zcash tab that used to sit next to the
// 2Z form sent ZEC to a Free2Z wallet with a `page_fund` memo -- a legacy
// protocol that is retired. ZEC sent to Free2Z is only ever for buying 2Z.
const BoostPageDialog: React.FC<BoostPageDialogProps> = ({ page, setPage, open, onClose }) => {
    const isXS = useMediaQuery('(max-width: 399px)')

    return (
        <Dialog
            open={open} onClose={onClose} maxWidth="xs" fullWidth
            fullScreen={isXS}
        >
            <DialogTitle>Boost page with 2Z</DialogTitle>

            <DialogContent
                style={{
                    minHeight: 300,
                }}
            >
                <BoostForm
                    page={page}
                    setPage={setPage}
                    onClose={onClose}
                />
                <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 2 }}>
                    Need 2Z? Buy them with Zcash or a card from your profile, then boost.
                </Typography>
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>Close</Button>
            </DialogActions>
        </Dialog>
    );
};

export default BoostPageDialog;
