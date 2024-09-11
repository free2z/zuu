import React from 'react';
import {
    Dialog, DialogContent, DialogTitle, Card, CardActionArea,
    CardContent, Typography, useMediaQuery, Theme, DialogActions,
    Button,
} from "@mui/material";
import { LiveMeetingInfo } from "./JoinLivesteam";
import { StreamType, TITLE_DESCRIPTION } from "./StartLiveStreamDialog";

interface JoinStreamConfirmDialogProps {
    open: boolean;
    onClose: () => void;
    onConfirm: (type: string) => void;
    liveMeetings: { [key: string]: LiveMeetingInfo };
}

const JoinStreamConfirmDialog: React.FC<JoinStreamConfirmDialogProps> = ({
    open,
    onClose,
    onConfirm,
    liveMeetings,
}) => {
    const isSmall = useMediaQuery((theme: Theme) => theme.breakpoints.down('md'));
    return (
        <Dialog onClose={onClose} open={open}
            fullScreen={isSmall}
            fullWidth={true}
            maxWidth="sm"
        >
            <DialogTitle>Choose a livestream to join</DialogTitle>
            <DialogContent>
                {Object.entries(liveMeetings).map(([type, info]) => (
                    <Card key={type} onClick={() => onConfirm(type)} sx={{ marginBottom: 2 }}>
                        <CardActionArea>
                            <CardContent>
                                <Typography gutterBottom variant="h5" component="div">
                                    {TITLE_DESCRIPTION[type as StreamType].title}
                                </Typography>
                                <Typography variant="body2" color="text.secondary">
                                    {TITLE_DESCRIPTION[type as StreamType].joinText(info.price_per_minute)}
                                </Typography>
                            </CardContent>
                        </CardActionArea>
                    </Card>
                ))}
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>Cancel</Button>
            </DialogActions>
        </Dialog>
    );
};

export default JoinStreamConfirmDialog;
