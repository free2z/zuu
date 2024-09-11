import React, { useState } from 'react';
import {
    Dialog, DialogContent, Typography, Card,
    CardActionArea, CardContent, Stepper, Step, StepLabel,
    Box, Button, Stack, useMediaQuery, Theme, DialogActions,
    FormControlLabel,
    Checkbox,
} from '@mui/material';
import { dispatch } from '../state/persist';
import { useTransitionNavigate } from '../hooks/useTransitionNavigate';
import PPVPriceWidget from './PPVPriceWidget';
import { useGlobalState } from '../state/global';
import TuzisMenuItem from './TuzisMenuItem';
import axios from 'axios';

// Define StreamType as a union of string literals
export type StreamType = 'private' | 'broadcast' | 'ppv' | 'subscribers-only';


// TitleDescription type with confirmText
interface TitleDescription {
    title: string;
    description: string;
    // The text shown when someone starts a stream
    confirmText: string;
    // The text shown when someone joins the stream
    joinText: (price: number) => string;
}

// TITLE_DESCRIPTION record with expanded properties
export const TITLE_DESCRIPTION: Record<StreamType, TitleDescription> = {
    private: {
        title: 'Private (Beta)',
        description: 'Private meetings are free to start and free for participants. You will get a link to send to participants.',
        confirmText: 'You pay 1 tuzi per 2 minutes for each participant. Participants pay nothing and can join anonymously by visiting your link.',
        joinText: (price) => '',
    },
    broadcast: {
        title: 'Public Broadcast',
        description: 'Free to start. Free to participants. You pay platform fees for participants.',
        confirmText: 'Broadcast streams are free to start. Participants pay nothing and can join without logging in. You pay 1 tuzi per 2 minutes for each participant',
        joinText: (price) => 'Join the free livestream broadcast!',
    },
    'subscribers-only': {
        title: 'Subscribers-Only',
        description: 'No platform fees. Participants must be subscribed to you to join.',
        confirmText: 'To help you grow your following and to help Free2Z grow, we offer subscribers-only streams with no platform fees. Participants must be logged in and subscribed to the creator to join.',
        joinText: (price) => 'Join subscribers-only stream. No platform fees. You must be logged in and subscribed to the creator to join.',
    },
    ppv: {
        title: 'Pay-Per-View',
        description: 'You pay nothing. Viewers pay platform fees and an optional price you set.',
        confirmText: 'Pay-per-view streams are free to start. Participants pay 1 tuzi per 2 minutes and an optional price you set. You can set a price of zero.',
        joinText: (price) => `Join pay-per-view stream. You must be logged in. You contribute ${price.toFixed(0)} 2Zs to the creator per minute. Platform fees apply.`,
    },
};

// Props for the StreamTypeOption component
interface StreamTypeOptionProps {
    type: StreamType;
    description: string;
    selected: boolean;
    onClick: () => void;
}

// StreamTypeOption component
const StreamTypeOption: React.FC<StreamTypeOptionProps> = ({
    type, selected, onClick
}) => {
    return (
        <Card onClick={onClick}>
            <CardActionArea>
                <CardContent>
                    <Typography gutterBottom variant="h5" component="div">
                        {TITLE_DESCRIPTION[type].title}
                        {/* {type.charAt(0).toUpperCase() + type.slice(1).replace('-', ' ')} */}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                        {TITLE_DESCRIPTION[type].description}
                    </Typography>
                </CardContent>
            </CardActionArea>
        </Card>
    );
};


// Props for the ConfirmStream component
interface ConfirmStreamProps {
    type: StreamType;
    // price: number;
    // onPriceChange: (event: ChangeEvent<HTMLInputElement>) => void;
}

const ConfirmStream: React.FC<ConfirmStreamProps> = ({ type }) => {
    return (
        <Stack spacing={2} mt={3} mb={3}>
            <Typography variant="h5" component="div">
                {TITLE_DESCRIPTION[type].title}
            </Typography>
            <Typography variant="body2" color="text.secondary">
                {TITLE_DESCRIPTION[type].description}
            </Typography>
            <Typography variant="caption" component="div">
                {TITLE_DESCRIPTION[type].confirmText}
            </Typography>
            {type === 'ppv' && (
                <PPVPriceWidget
                    onChange={(price) => (
                        dispatch({
                            type: "setPpvPrice",
                            price: price,
                        })
                    )}
                />
            )}
            {type === 'private' && (
                // A disabled checkbox to turn on e2ee (TODO)
                <FormControlLabel
                    control={
                        <Checkbox
                            disabled
                            name="e2ee"
                        />
                    }
                    label="Enable End-to-End Encryption (E2EE) - Coming Soon!"
                />
            )}
        </Stack>
    );
};

// Props for the StartLiveStreamDialog component
interface StartLiveStreamDialogProps {
    open: boolean;
    onClose: () => void;
    creatorUsername: string;
}

// StartLiveStreamDialog component
const StartLiveStreamDialog: React.FC<StartLiveStreamDialogProps> = ({ open, onClose, creatorUsername }) => {
    const steps = ['Choose Stream Type', 'Confirm Your Stream'];

    const [creator, setCreator] = useGlobalState("creator")
    const [activeStep, setActiveStep] = useState<number>(0);
    const [streamType, setStreamType] = useState<StreamType | null>(null);
    const [price, setPrice] = useState(0);
    const navigate = useTransitionNavigate();
    const fullScreen = useMediaQuery((theme: Theme) => theme.breakpoints.down('sm'));

    const handleStreamTypeSelect = (type: StreamType) => {
        setStreamType(type);
        setActiveStep(prevActiveStep => prevActiveStep + 1);
    };

    const handleBack = () => {
        setActiveStep((prevActiveStep) => Math.max(prevActiveStep - 1, 0));
    };

    const handleConfirm = () => {
        if (streamType === 'private') {
            axios.post(`/api/dyte/${creatorUsername}/private`).then((res) => {
                navigate(`/${creatorUsername}/private/${res.data.secret}`);
            })
            return
        }
        navigate(`/${creatorUsername}/${streamType}`);
    };

    const renderStepContent = (step: number) => {
        switch (step) {
            case 0:
                return <Stack spacing={1} mt={3} mb={3}>
                    {(Object.keys(TITLE_DESCRIPTION) as StreamType[]).map((type) => (
                        <StreamTypeOption
                            key={type}
                            type={type}
                            description={TITLE_DESCRIPTION[type].description}
                            selected={streamType === type}
                            onClick={() => handleStreamTypeSelect(type)}
                        />
                    ))}
                </Stack>
            case 1:
                return streamType && (
                    <Card
                        sx={{ mt: 3 }}
                    >
                        <CardContent>
                            <ConfirmStream
                                type={streamType}
                            />
                        </CardContent>
                    </Card>
                );
            default:
                return 'Unknown step';
        }
    };

    // if creator tuzi balance is less than 150, show a message
    if (Number(creator.tuzis) < 150) {
        return (
            <Dialog
                open={open}
                onClose={onClose}
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

    return (
        <Dialog open={open} onClose={onClose}
            maxWidth="sm"
            fullWidth
            fullScreen={fullScreen}
        >
            {/* <DialogTitle>Start a Livestream</DialogTitle> */}
            <DialogContent>
                <Stepper activeStep={activeStep} alternativeLabel

                >
                    {steps.map((label, index) => (
                        <Step key={label} onClick={() => setActiveStep(index)} completed={activeStep > index}>
                            <StepLabel
                            >{label}</StepLabel>
                        </Step>
                    ))}
                </Stepper>
                <div>
                    {renderStepContent(activeStep)}
                </div>
            </DialogContent>
            {activeStep === 0 && (
                <DialogActions>
                    <Button onClick={onClose}>
                        Close
                    </Button>
                </DialogActions>

            )}
            {activeStep === 1 && (
                <DialogActions>
                    <Box
                        component="div"
                        sx={{ display: 'flex', flexDirection: 'row', pt: 1 }}
                    >

                        <Button
                            color="inherit"
                            onClick={handleBack}
                            sx={{ mr: 1 }}
                        >
                            Back
                        </Button>
                        <Box
                            component="div"
                            sx={{ flex: '1 1 auto' }}
                        />
                        <Button onClick={handleConfirm}
                            color="success"
                            variant="contained"
                        >
                            Start Stream
                        </Button>
                    </Box>
                </DialogActions>
            )}
        </Dialog >
    );
};

export default StartLiveStreamDialog;
