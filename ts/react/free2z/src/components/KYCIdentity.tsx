import { useState } from 'react';
import {
    Box, Button, Container, IconButton, Stack,
} from '@mui/material';
import DragDropFileUpload from './DragDropFileUpload';
import LightboxImage from './CustomImage';
import { useQuery, useQueryClient } from 'react-query';
import axios from 'axios';
import { KYCState, KYCAction } from './KYCPage';
import { Delete } from '@mui/icons-material';
import KYCCircularProgress from './KYCCircularProgress';
import { useGlobalState } from '../state/global';

type DocType = 'id_front' | 'id_back' | 'additional_document' | 'live_photo';

export type KYCIdentityProps = {
    state: KYCState;
    dispatch: React.Dispatch<KYCAction>;
};

export default function KYCIdentity({ state, dispatch }: KYCIdentityProps) {
    const queryClient = useQueryClient();
    const [snackbar, setSnackbar] = useGlobalState('snackbar');
    const [isUploading, setUploading] = useState<Record<DocType, boolean>>({
        id_front: false,
        id_back: false,
        additional_document: false,
        live_photo: false,
    });

    // Fetch existing file URLs
    const { data, isLoading } = useQuery('kycIdentityFiles', async () => {
        const response = await axios.get('/api/kyc/identity-documents');
        return response.data;
    });

    const uploadFile = async (fileData: { type: DocType, file: File }) => {
        setUploading(prev => ({ ...prev, [fileData.type]: true }));
        const formData = new FormData();
        formData.append(fileData.type, fileData.file);
        try {
            await axios.post('/api/kyc/identity-documents', formData);
            queryClient.invalidateQueries('kycIdentityFiles');
        } catch (error: any) {
            console.log(error)
            setSnackbar({
                open: true,
                severity: 'error',
                message: error?.data?.error || 'Error uploading file',
                duration: 6000,
            });
        } finally {
            setUploading(prev => ({ ...prev, [fileData.type]: false }));
        }
    };

    const deleteFile = async (docType: DocType) => {
        try {
            await axios.delete('/api/kyc/identity-documents', { data: { doc_type: docType } });
            queryClient.invalidateQueries('kycIdentityFiles');
        } catch (error: any) {
            console.log(error)
            setSnackbar({
                open: true,
                severity: 'error',
                message: error?.data?.error || 'Error deleting file',
                duration: 6000,
            });
        }
    }

    // Handlers for file uploads and deletions
    const handleFileUpload = (docType: DocType) => (file: File) => {
        uploadFile({ type: docType, file });
    };

    const handleFileDelete = (docType: DocType) => () => {
        deleteFile(docType);
    };

    const renderDocumentSection = (docType: DocType, instructions: string, altText: string) => {
        return (
            <>
                {!data[`${docType}_url`] && (
                    <DragDropFileUpload
                        instructions={instructions}
                        onFileSelect={handleFileUpload(docType)}
                        disabled={isUploading[docType]}
                    />
                )}

                {data[`${docType}_url`] && (
                    <Stack direction="row" justifyContent="center" alignItems="center"
                        sx={{ mt: 2 }}
                    >
                        <LightboxImage src={data[`${docType}_url`]} alt={altText} />
                        <IconButton aria-label="delete" onClick={handleFileDelete(docType)}>
                            <Delete />
                        </IconButton>
                    </Stack>
                )}
            </>
        );
    };

    // Render the component UI
    return (
        <Container>
            {/* ID Front Upload */}
            {!isLoading ? (
                <>
                    {renderDocumentSection('id_front', 'Upload the front of your government-issued ID.', 'ID Front')}
                    {/* ID Back Section */}
                    {renderDocumentSection('id_back', '(Optional) Upload the back of your government-issued ID.', 'ID Back')}
                    {/* Additional Document Section */}
                    {renderDocumentSection('additional_document', '(Optional) Upload proof of residence', 'Additional Document')}
                </>
            ) : <KYCCircularProgress />}

            {/* Navigation Buttons */}
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
                    onClick={() => dispatch({ type: 'NEXT_STEP' })}
                    disabled={!data?.id_front_url}
                >
                    Next
                </Button>
            </Box>
        </Container>
    );
}
