import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import Switch from '@mui/material/Switch';
import { Stack, Typography } from '@mui/material';
import { useGlobalState } from '../state/global';

type EmailTogglePublicProps = {
    getNotifications: boolean;
};

export default function EmailToggleNotifications(props: EmailTogglePublicProps) {
    const { getNotifications } = props;
    const [checked, setChecked] = useState(getNotifications);
    const [snackbar, setSnackbar] = useGlobalState('snackbar');
    const [shouldPost, setShouldPost] = useState(false);

    useEffect(() => {
        if (!shouldPost) {
            return
        }
        const postData = async () => {
            try {
                const response = await axios.post('/api/emails/notifications', { value: checked });
                console.log('Post successful:', response.data);
                setSnackbar({ open: true, message: 'Email notifications updated', severity: 'success', duration: 3000 });
            } catch (error) {
                console.error('Error posting data:', error);
                setSnackbar({ open: true, message: 'Error updating notifications', severity: 'error', duration: null });
            }
        };
        postData();
    }, [checked, shouldPost]);

    const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        // console.log('handleChange', event.target.checked);
        setChecked(event.target.checked);
        setShouldPost(true);
    };

    return (
        <Stack direction="row" spacing={1}
            alignItems="center"
            // justifyContent="flex-start"
            justifyContent="flex-end"
        >
            <Typography variant="caption">Notify</Typography>
            <Switch
                checked={checked}
                onChange={handleChange}
            />
        </Stack>
    );
}
