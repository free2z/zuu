import React from 'react';
import Switch from '@mui/material/Switch';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import axios from 'axios';
import { Stack, Typography } from '@mui/material';
import { useGlobalState } from '../state/global';

type PublicStatus = {
    is_public: boolean;
    allow_login: boolean;
};


const fetchPublicStatus = async () => {
    const response = await axios.get('/api/twitter/public-status/');
    // is_public
    // allow_login
    return response.data as PublicStatus;
};

const updatePublicStatus = async (data: PublicStatus) => {
    await axios.put('/api/twitter/public-status/', data);
    return data;
};

const TwitterIsPublicSwitch: React.FC = () => {
    const [snackbar, setSnackbar] = useGlobalState('snackbar');
    const queryClient = useQueryClient();
    const { data, isLoading } = useQuery(
        'publicStatus', fetchPublicStatus);

    const { data: passwordIsSetData } = useQuery('passwordIsSet', () =>
        axios.get('/api/emails/password-is-set')
    );
    const passwordIsSet = passwordIsSetData?.data?.password_set;

    const mutation = useMutation(updatePublicStatus, {
        onSuccess: (newStatus) => {
            queryClient.setQueryData('publicStatus', newStatus);
            setSnackbar({
                open: true,
                message: 'Twitter Configuration Updated',
                severity: 'success',
                duration: 3000,
            });
        },
        onError: (error) => {
            console.error('Error updating public status:', error);
            setSnackbar({
                open: true,
                message: 'Error updating public status',
                severity: 'error',
                duration: null,
            });
        },
    });

    const handleTogglePublic = () => {
        if (!data) {
            return;
        }
        mutation.mutate({
            is_public: !data.is_public,
            allow_login: data.allow_login,
        });
    };

    const handleToggleLogin = () => {
        if (!data) {
            return;
        }
        mutation.mutate({
            is_public: data.is_public,
            allow_login: !data.allow_login,
        });
    };

    if (isLoading || !data) {
        return <Typography>Loading...</Typography>;
    }

    return (
        <Stack direction="column" spacing={0}
            alignItems="center"
            justifyContent="center"
        >
            <Stack direction="row" spacing={1}
                alignItems="center"
                justifyContent="flex-end"
            >
                <Typography variant='caption'>Public</Typography>
                <Switch
                    checked={data.is_public}
                    onChange={handleTogglePublic}
                />
            </Stack>
            <Stack direction="row" spacing={1}
                alignItems="center"
                justifyContent="flex-end"
            >
                <Typography variant='caption'>Login</Typography>
                <Switch
                    checked={data.allow_login}
                    onChange={handleToggleLogin}
                    disabled={!passwordIsSet}
                />
            </Stack>
        </Stack>
    );
};

export default TwitterIsPublicSwitch
