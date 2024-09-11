import React, { useState } from 'react';
import {
    Box, Typography, Button, TextField, CircularProgress, Checkbox, FormControlLabel,
} from '@mui/material';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import axios from 'axios';
import { KYCTaxFormStepProps } from './KYCTaxFormStep';
import { useGlobalState } from '../state/global';

const fetchSignature = async () => {
    const { data } = await axios.get('/api/kyc/tax-form-signature');
    // console.log("??", data)
    return data
};

const submitSignature = async (signature: string) => {
    await axios.post('/api/kyc/tax-form-signature', { tax_form_signature: signature });
};

export default function KYCElectronicSignature(props: KYCTaxFormStepProps) {
    const { state, dispatch } = props;
    const [snackbar, setSnackbar] = useGlobalState('snackbar');
    const [checked, setChecked] = useState(false); // New state variable for checkbox
    const [signature, setSignature] = useState('');
    const queryClient = useQueryClient();

    const handleCheckboxChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        setChecked(event.target.checked);
    };

    const { data: existingSignature, isLoading } = useQuery('signature', fetchSignature, {
        onSuccess: (data) => {
            // console.log("!!!", data)
            // console.log("!!!*****", data.tax_form_signature)
            setSignature(data.tax_form_signature);
        },
        onError: (error) => {
            console.error('Error fetching signature:', error);
            setSnackbar({
                open: true,
                severity: 'error',
                message: 'Error fetching signature. Please try again.',
                duration: null,
            });
        }
    });

    const mutation = useMutation(submitSignature, {
        onSuccess: () => {
            // setSnackbar({
            //     open: true,
            //     message: 'Signature submitted successfully',
            //     severity: 'success',
            //     duration: 6000,
            // });
            dispatch({ type: 'NEXT_STEP' });
            queryClient.invalidateQueries('signature');
        },
        onError: (error) => {
            console.error('Error submitting signature:', error);
            setSnackbar({
                open: true,
                severity: 'error',
                message: 'Error submitting signature. Please try again.',
                duration: null,
            });
        }
    });

    const handleSignatureChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        setSignature(event.target.value);
    };

    const handleSubmit = () => {
        // console.log("SUBMIT", signature)
        mutation.mutate(signature);
    };

    if (isLoading) {
        return (
            <Box
                component="div"
                sx={{
                    width: '100%',
                    minHeight: '160px',
                    position: 'relative',
                }}
            >
                <CircularProgress
                    sx={{
                        position: 'absolute',
                        top: '50%',
                        left: '50%',
                        marginTop: '-20px',
                        marginLeft: '-20px',
                    }}
                />;
            </Box>
        )
    }

    return (
        <Box component="div"
            sx={{
                mt: 2,
            }}
        >
            <TextField
                label="Type Your Full Name"
                helperText="This will act as your electronic signature"
                variant="outlined"
                value={signature || existingSignature.tax_form_signature || ''}
                onChange={handleSignatureChange}
                sx={{ mb: 2, width: '100%' }}
            />
            <FormControlLabel
                control={
                    <Checkbox
                        checked={checked}
                        onChange={handleCheckboxChange}
                        name="legalConfirmation"
                        color="primary"
                    />
                }
                label={<Typography variant="caption">
                    I understand that this acts as my legal signature for the uploaded tax document.
                </Typography>}
                labelPlacement='start'
            />
            <Box component="div" sx={{ display: 'flex', justifyContent: 'space-between', mt: 2 }}>
                <Button variant="outlined" color="inherit" onClick={() => dispatch({ type: 'PREVIOUS_STEP' })}>
                    Back
                </Button>
                <Button
                    variant="contained" color="primary" onClick={handleSubmit}
                    disabled={!signature || !checked}
                    sx={{ minWidth: '100px' }}
                >
                    {mutation.isLoading ? <CircularProgress color="inherit" size={24} /> : 'Submit'}
                </Button>
            </Box>
        </Box>
    );
}
