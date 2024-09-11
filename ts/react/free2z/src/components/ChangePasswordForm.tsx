import React, { useState } from 'react';
import { Button, TextField, InputAdornment, Stack, Typography } from '@mui/material';
import LockIcon from '@mui/icons-material/Lock';
import Visibility from '@mui/icons-material/Visibility';
import { useMutation, useQuery, useQueryClient } from 'react-query';
import axios from 'axios';
import { useGlobalState } from '../state/global';

type ChangePasswordFormProps = {
    // Any props if required
};

const ChangePasswordForm: React.FC<ChangePasswordFormProps> = () => {
    const [oldPassword, setOldPassword] = useState<string>('');
    const [newPassword, setNewPassword] = useState<string>('');
    const [passwordVisible, setPasswordVisible] = useState<boolean>(false);
    const [snackbar, setSnackbar] = useGlobalState('snackbar');

    const queryClient = useQueryClient();

    const { data: passwordIsSetData, isLoading } = useQuery('passwordIsSet', () =>
        axios.get('/api/emails/password-is-set')
    );
    const passwordIsSet = passwordIsSetData?.data?.password_set;

    const changePasswordMutation = useMutation(() => {
        const payload = passwordIsSet ? {
            old_password: oldPassword,
            new_password: newPassword,
        } : { new_password: newPassword };
        return axios.post('/api/emails/change-password', payload);
    }, {
        onSuccess: () => {
            setOldPassword('');
            setNewPassword('');
            setSnackbar({
                open: true,
                severity: 'success',
                message: passwordIsSet ? 'Password changed successfully!' : 'Password set successfully!',
                duration: 6000
            });
            // clear the passwordIsSet cache
            queryClient.invalidateQueries('passwordIsSet');
        },
        onError: (error: any) => {
            let message = error.data?.new_password || 'An error occurred while setting the password.';
            setSnackbar({
                open: true,
                severity: 'error',
                message: message,
                duration: null
            });
        }
    });

    const handleSubmit = () => {
        setPasswordVisible(false);
        changePasswordMutation.mutate();
    };

    if (isLoading) {
        return <Typography>Loading...</Typography>
    }

    return (
        <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={{ xs: 1, sm: 3 }}
            alignItems="center"
            justifyContent="center"
        >
            <Stack direction="column"
                sx={{
                    minWidth: { xs: '100%', sm: '50%' },
                }}
            >
                {passwordIsSet && (

                    <TextField
                        margin="dense"
                        id="old-password"
                        label="Current Password"
                        type={!passwordVisible ? "password" : "text"}
                        fullWidth
                        variant="standard"
                        color="warning"
                        value={oldPassword}
                        onChange={(e) => setOldPassword(e.target.value)}
                        InputProps={{
                            endAdornment: (
                                <InputAdornment position="start">
                                    {passwordVisible ? (
                                        <LockIcon
                                            onClick={() => setPasswordVisible(false)}
                                            color="warning"
                                        />
                                    ) : (
                                        <Visibility
                                            onClick={() => setPasswordVisible(true)}
                                            color="warning"
                                        />
                                    )}
                                </InputAdornment>
                            ),
                        }}
                    />
                )}
                <TextField
                    margin="dense"
                    id="new-password"
                    label="New Password"
                    type={!passwordVisible ? "password" : "text"}
                    fullWidth
                    variant="standard"
                    color="warning"
                    value={newPassword}
                    helperText="Keep your password secure!"
                    onChange={(e) => setNewPassword(e.target.value)}
                    InputProps={{
                        endAdornment: (
                            <InputAdornment position="start">
                                {passwordVisible ? (
                                    <LockIcon
                                        onClick={() => setPasswordVisible(false)}
                                        color="warning"
                                    />
                                ) : (
                                    <Visibility
                                        onClick={() => setPasswordVisible(true)}
                                        color="warning"
                                    />
                                )}
                            </InputAdornment>
                        ),
                    }}
                />
            </Stack>
            <Button
                type="submit"
                variant="contained"
                color="primary"
                disabled={changePasswordMutation.isLoading}
                onClick={handleSubmit}
            >
                {passwordIsSet ? "Change Password" : "Set Password"}
            </Button>
        </Stack>
    );
};

export default ChangePasswordForm;
