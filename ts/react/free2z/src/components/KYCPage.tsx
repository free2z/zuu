import { useEffect, useReducer } from 'react';
import {
    Step, StepContent, StepLabel, Stepper, Button, Typography, Container, Box,
} from '@mui/material';

import KYCBasicInfoStep from './KYCBasicInfoStep';
import KYCTaxFormStep from './KYCTaxFormStep';
import KYCIdentity from './KYCIdentity';
import { useGlobalState } from '../state/global';
import { useTransitionNavigate } from '../hooks/useTransitionNavigate';
import KYCElectronicSignature from './KYCElectronicSignature';
import KYCLivePhotoCapture from './KYCLivePhotoCapture';
import axios from 'axios';
import { Helmet } from 'react-helmet-async';


export type KYCState = {
    activeStep: number;
    is_us: boolean | null;
    is_individual: boolean | null;
    // tax_form_file: File | null;
    tax_form_file_url: string | null;
    uploading: boolean;
};

export type KYCAction =
    | { type: 'NEXT_STEP' }
    | { type: 'PREVIOUS_STEP' }
    | { type: 'SET_IS_US'; payload: boolean | null }
    | { type: 'SET_IS_INDIVIDUAL'; payload: boolean | null }
    // | { type: 'SET_TAX_FORM_FILE'; payload: File | null }
    | { type: 'SET_UPLOADING'; payload: boolean }
    | { type: 'SET_TAX_FORM_FILE_URL'; payload: string | null }
    ;

const initialState = {
    activeStep: 0,
    is_us: null,
    is_individual: null,
    // tax_form_file: null,
    tax_form_file_url: null,
    uploading: false,
};

function kycReducer(state: KYCState, action: KYCAction): KYCState {
    switch (action.type) {
        case 'NEXT_STEP':
            return { ...state, activeStep: state.activeStep + 1 };
        case 'PREVIOUS_STEP':
            return { ...state, activeStep: state.activeStep - 1 };
        case 'SET_IS_US':
            return { ...state, is_us: action.payload };
        case 'SET_IS_INDIVIDUAL':
            return { ...state, is_individual: action.payload };
        // case 'SET_TAX_FORM_FILE':
        //     return { ...state, tax_form_file: action.payload };
        case 'SET_UPLOADING':
            return { ...state, uploading: action.payload };
        case 'SET_TAX_FORM_FILE_URL':
            return { ...state, tax_form_file_url: action.payload };
        default:
            return state;
    }
}


export default function KYCPage() {
    const [creator, setCreator] = useGlobalState('creator');
    const [loginModal, setLoginModal] = useGlobalState('loginModal');
    const [authStatus, _a] = useGlobalState("authStatus")
    const [snackbar, setSnackbar] = useGlobalState('snackbar');
    const [loading, setLoading] = useGlobalState('loading');
    const [state, dispatch] = useReducer(kycReducer, initialState);

    const navigate = useTransitionNavigate();

    const handleNext = () => {
        dispatch({ type: 'NEXT_STEP' });
    };

    const handleBack = () => {
        dispatch({ type: 'PREVIOUS_STEP' });
    };

    useEffect(() => {
        if (authStatus === null) {
            setLoading(true)
            setLoginModal(false)
            return
        } else if (authStatus === false) {
            setLoading(false)
            setLoginModal(true)
            return
        }
        setLoading(false)
        setLoginModal(false)
        if (Number(creator.tuzis) < 150) {
            setSnackbar({
                open: true,
                severity: 'warning',
                message: 'You need at least 150 to apply for revenue share.',
                duration: null,
            });
            navigate('/profile')
        }
    }, [creator.username, setLoading, setLoginModal, authStatus])

    return (
        <>
            <Helmet>
                <title>Apply for Revenue Share</title>
            </Helmet>
            <Stepper
                activeStep={state.activeStep}
                orientation="vertical"
                sx={{
                    width: '100%',
                    minWidth: '300px',
                    margin: '1em auto',
                    maxWidth: '633px',
                }}
            >
                {/* Explanation */}
                <Step>
                    <StepLabel>Applying for Revenue Share</StepLabel>
                    <StepContent>
                        <Container sx={{ mt: 1, textAlign: 'left' }}>
                            <Typography variant="body1" gutterBottom>
                                Welcome to our secure and streamlined revenue-sharing program.
                                Before we can process payments,
                                we are legally required to verify your identity and
                                ensure compliance with Anti-Money Laundering (AML) regulations.
                            </Typography>
                            <Typography variant="body1" gutterBottom>
                                Our process is simple and straightforward:
                            </Typography>
                            <ul>
                                <Typography component="li" variant="body1">Provide basic personal information.</Typography>
                                <Typography component="li" variant="body1">Complete and e-sign the relevant tax form.</Typography>
                                {/* (W-9 for US taxpayers, W-8BEN for nonresident aliens, or W-8BEN-E for foreign entities). */}
                                <Typography component="li" variant="body1">Upload a state-issued identification for verification.</Typography>
                            </ul>
                            <Typography variant="body1" gutterBottom>
                                Your privacy is our priority. All information is encrypted and securely stored, ensuring compliance with data protection standards.
                            </Typography>
                            <Box component="div" sx={{ display: 'flex', justifyContent: 'flex-end' }}>

                                <Button variant="contained" color="primary" onClick={handleNext} sx={{ mt: 2 }}>
                                    Start
                                </Button>
                            </Box>
                        </Container>
                    </StepContent>
                </Step>
                {/* Basic Information */}
                <Step>
                    <StepLabel>Basic Information</StepLabel>
                    <StepContent>
                        <KYCBasicInfoStep
                            state={state}
                            dispatch={dispatch}
                        />
                    </StepContent>
                </Step>
                {/* Tax Form */}
                <Step>
                    <StepLabel>Tax Form</StepLabel>
                    <StepContent>
                        <KYCTaxFormStep
                            state={state}
                            dispatch={dispatch}
                        />
                    </StepContent>
                </Step>
                <Step>
                    <StepLabel>Electronic Signature</StepLabel>
                    <StepContent>
                        <KYCElectronicSignature
                            state={state}
                            dispatch={dispatch}
                        />
                    </StepContent>
                </Step>
                {/* Identity Document */}
                <Step>
                    <StepLabel>Identity Document</StepLabel>
                    <StepContent>
                        <KYCIdentity
                            state={state}
                            dispatch={dispatch}
                        />
                    </StepContent>
                </Step>
                {/* Live Photo */}
                <Step>
                    <StepLabel>Live Photo</StepLabel>
                    <StepContent>
                        <KYCLivePhotoCapture
                            state={state}
                            dispatch={dispatch}
                        />
                    </StepContent>
                </Step>
                {/* Finalize and submit */}
                <Step>
                    <StepLabel>Finalize and Submit</StepLabel>
                    <StepContent>
                        <Container sx={{ mt: 3, mb: 2 }}>
                            <Typography variant="body1" gutterBottom>
                                Please review your information and confirm.
                            </Typography>
                            <Box component="div" sx={{ display: 'flex', justifyContent: 'space-between', mt: 4 }}>
                                <Button
                                    variant="outlined" color="inherit"
                                    onClick={() => dispatch({ type: 'PREVIOUS_STEP' })}
                                >
                                    Back
                                </Button>
                                <Button
                                    variant="contained"
                                    color="primary"
                                    onClick={() => {
                                        // dispatch({ type: 'NEXT_STEP' })
                                        // POST and set status
                                        axios.post('/api/kyc/change-status').then((res) => {
                                            navigate('/profile')
                                        }).catch(() => {
                                            // console.error(err);
                                            setSnackbar({
                                                open: true,
                                                severity: 'error',
                                                message: 'Error changing status. Please try again.',
                                                duration: null,
                                            })
                                        })
                                    }}
                                // disabled={!data?.live_photo_url}
                                >
                                    Confirm
                                </Button>
                            </Box>
                        </Container>
                    </StepContent>
                </Step>
            </Stepper>
        </>
    );
}
