import React from 'react';
import { useMutation, useQuery } from 'react-query';
import axios from 'axios';
import { Button, Container, Box, CircularProgress } from '@mui/material';
import { KYCAction, KYCState } from './KYCPage';

import KYCTaxForm from './KYCTaxForm';
import { useGlobalState } from '../state/global';

export type KYCTaxFormStepProps = {
    state: KYCState;
    dispatch: React.Dispatch<KYCAction>;
};

export type KYCTaxFormProps = {
    state: KYCState;
    dispatch: React.Dispatch<KYCAction>;
    handleFileSelect: (file: File) => void;
    handleDeleteFile: () => void;
};

export default function KYCTaxFormStep({ state, dispatch }: KYCTaxFormStepProps) {
    const [uploadProgress, setUploadProgress] = React.useState(0);
    const [snackbar, setSnackbar] = useGlobalState('snackbar');

    const fetchInitialState = useQuery('initialTaxForm', () =>
        axios.get('/api/kyc/get-tax-form-file'), {
        onSuccess: (data) => {
            dispatch({ type: 'SET_TAX_FORM_FILE_URL', payload: data.data.file });
        },
        onError: (error) => {
            console.error('Error fetching initial state:', error);
            setSnackbar({
                open: true,
                severity: 'error',
                message: 'Error fetching initial state. Please try again.',
                duration: null,
            });
        }
    }
    );

    const uploadMutation = useMutation((file: File) => {
        const formData = new FormData();
        formData.append('file', file);
        return axios.post('/api/kyc/upload-tax-form', formData, {
            onUploadProgress: (progressEvent) => {
                const progress = Math.round((progressEvent.loaded * 100) / progressEvent.total);
                setUploadProgress(progress);
            }
        });
    }, {
        onSuccess: (res) => {
            dispatch({ type: 'SET_UPLOADING', payload: false });
            dispatch({ type: 'SET_TAX_FORM_FILE_URL', payload: res.data.file_url });
            setUploadProgress(0);
        },
        onError: (error: any) => {
            console.error('Error uploading file:', error);
            dispatch({ type: 'SET_UPLOADING', payload: false });
            setSnackbar({
                open: true,
                severity: 'error',
                message: error?.data?.message || 'Error uploading file. Please try again.',
                duration: null,
            });
            setUploadProgress(0);
        }
    });

    const handleFileSelect = (file: File) => {
        dispatch({ type: 'SET_UPLOADING', payload: true });
        uploadMutation.mutate(file);
    };

    const deleteMutation = useMutation(() => axios.delete('/api/kyc/delete-tax-form'), {
        onSuccess: () => {
            dispatch({ type: 'SET_UPLOADING', payload: false });
            dispatch({ type: 'SET_TAX_FORM_FILE_URL', payload: null });
        },
        onError: (error) => {
            console.error('Error deleting file:', error);
            setSnackbar({
                open: true,
                severity: 'error',
                message: 'Error deleting file. Please try again.',
                duration: null,
            });
        }
    });

    const handleDeleteFile = () => {
        deleteMutation.mutate();
    };

    const renderTaxForm = () => {
        if (fetchInitialState.isLoading || fetchInitialState.isFetching) return (
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
        if (fetchInitialState.isError) return null;

        return (
            <KYCTaxForm
                state={state}
                dispatch={dispatch}
                handleFileSelect={handleFileSelect}
                handleDeleteFile={handleDeleteFile}
            />
        )
    };

    return (
        <Container>
            {renderTaxForm()}
            <Box component="div" sx={{ display: 'flex', justifyContent: 'space-between', mt: 2 }}>
                <Button variant="outlined" color="inherit"
                    onClick={() => dispatch({ type: 'PREVIOUS_STEP' })}
                >
                    Back
                </Button>
                <Button
                    variant="contained"
                    color="primary"
                    onClick={() => dispatch({ type: 'NEXT_STEP' })}
                    disabled={!state.tax_form_file_url}
                >
                    Next
                </Button>
            </Box>
        </Container>
    );
}
