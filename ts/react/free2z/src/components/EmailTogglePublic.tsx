import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import Switch from '@mui/material/Switch';
import { Stack, Typography } from '@mui/material';
import { useGlobalState } from '../state/global';

type EmailTogglePublicProps = {
    isPublic: boolean;
};

export default function EmailTogglePublic(props: EmailTogglePublicProps) {
    const { isPublic } = props;
    const [checked, setChecked] = useState(isPublic);

    const [shouldPost, setShouldPost] = useState(false); // New state to track user interaction

    const [snackbar, setSnackbar] = useGlobalState('snackbar');

    useEffect(() => {
        if (!shouldPost) {
            return
        }
        const postData = async () => {
            try {
                const response = await axios.post('/api/emails/public', { value: checked });
                console.log('Post successful:', response.data);
                setSnackbar({ open: true, message: 'Public Email Updated', severity: 'success', duration: 3000 });
            } catch (error) {
                console.error('Error posting data:', error);
                setSnackbar({ open: true, message: 'Error updating public', severity: 'error', duration: null });
            }
        };
        postData();
    }, [checked, shouldPost]);

    const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        setChecked(event.target.checked);
        setShouldPost(true);
    };

    return (
        <Stack direction="row" spacing={1}
            alignItems="center"
            justifyContent="flex-end"
        >
            <Typography variant='caption'>Public</Typography>
            <Switch
                checked={checked}
                onChange={handleChange}
            />
        </Stack>
    );
}
