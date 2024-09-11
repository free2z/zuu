// KYCLivePhotoCapture.tsx
import React, { useState } from 'react';
import Webcam from "react-webcam";
import { Box, Button, IconButton, Stack } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import { useMutation, useQuery, useQueryClient } from 'react-query';
import axios from 'axios';
import { KYCTaxFormStepProps } from './KYCTaxFormStep';

type LivePhotoResponse = {
    live_photo_url: string;
};

const KYCLivePhotoCapture: React.FC<KYCTaxFormStepProps> = ({ state, dispatch }) => {
    const webcamRef = React.useRef<Webcam>(null);
    const [imageSrc, setImageSrc] = useState<string | null>(null);
    const [justSaved, setJustSaved] = useState(false);
    const queryClient = useQueryClient();

    // Load initial state
    const { data, isLoading } = useQuery<LivePhotoResponse>('livePhoto', () =>
        axios.get('/api/kyc/identity-documents').then(res => res.data)
    );

    // Mutations for saving and deleting the live photo
    const saveMutation = useMutation((formData: FormData) =>
        axios.post('/api/kyc/identity-documents', formData, {
            headers: {
                'Content-Type': 'multipart/form-data'
            }
        }),
        {
            onSuccess: () => {
                queryClient.invalidateQueries('livePhoto');
                queryClient.refetchQueries('livePhoto').then(() => {
                    setImageSrc(null);
                    setJustSaved(false)
                });

            },
        }
    );

    const deleteMutation = useMutation((docType: { doc_type: string }) =>
        axios.delete('/api/kyc/identity-documents', { data: docType }),
        {
            onSuccess: () => {
                setImageSrc(null);
                queryClient.invalidateQueries('livePhoto');
            },
        }
    );

    // Delete the photo
    const deletePhoto = () => {
        deleteMutation.mutate({ doc_type: 'live_photo' });
    };


    // Capture the photo from the webcam
    const capture = React.useCallback(() => {
        const imageSrc = webcamRef.current?.getScreenshot() || null;
        setImageSrc(imageSrc);
    }, [webcamRef]);

    const savePhoto = () => {
        if (imageSrc) {
            const formData = new FormData();
            const blob = dataURLtoBlob(imageSrc);
            // Create a file from the blob with a meaningful name
            const filename = `live_photo_${new Date().toISOString()}.jpg`; // Using ISO string for uniqueness
            const file = new File([blob], filename, { type: 'image/jpeg' });
            formData.append('live_photo', file);
            setJustSaved(true);
            saveMutation.mutate(formData); // Adjust your mutation to handle formData
        }
    };

    // Convert DataURL to Blob
    const dataURLtoBlob = (dataurl: string) => {
        const arr = dataurl.split(',');
        const mime = arr[0].match(/:(.*?);/)?.[1];
        const bstr = atob(arr[1]);
        let n = bstr.length;
        const u8arr = new Uint8Array(n);

        while (n--) {
            u8arr[n] = bstr.charCodeAt(n);
        }

        return new Blob([u8arr], { type: mime });
    };

    // console.log("data!!!", data)

    const isNoPicture = !isLoading && !imageSrc && !data?.live_photo_url && !justSaved;
    const isPictureAlreadySaved = !isLoading && !imageSrc && data?.live_photo_url;
    const isNewPictureJustTaken = imageSrc;

    return (
        <Box component="div">
            {isLoading && <p>Loading...</p>}

            {isNoPicture && (
                <Stack direction="column" justifyContent="center" alignItems="center">
                    <Webcam
                        audio={false}
                        ref={webcamRef}
                        screenshotFormat="image/jpeg"
                        width={260}
                    />
                    <Button onClick={capture}>Capture Photo</Button>
                </Stack>
            )}

            {isPictureAlreadySaved && (
                <Stack direction="column" justifyContent="center" alignItems="center">
                    <img src={data.live_photo_url} alt="Live Photo" />
                    <IconButton onClick={() => deletePhoto()}>
                        <DeleteIcon />
                    </IconButton>
                </Stack>
            )}

            {isNewPictureJustTaken && (
                <Stack direction="column" justifyContent="center" alignItems="center">
                    <img src={imageSrc} alt="Live Photo" />
                    <Stack direction="row" justifyContent="center" alignItems="center">
                        <Button onClick={savePhoto}>Save Photo</Button>
                        <IconButton onClick={() => setImageSrc(null)}>
                            <DeleteIcon />
                        </IconButton>
                    </Stack>
                </Stack>
            )}

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
                    disabled={!data?.live_photo_url}
                >
                    Next
                </Button>
            </Box>
        </Box>
    );
};

export default KYCLivePhotoCapture;
