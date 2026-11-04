import React, { useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
    TextField, Button, Stack, Typography, Grid, InputAdornment,
} from '@mui/material';
import axios from 'axios';
import { Visibility } from '@mui/icons-material';
import LockIcon from '@mui/icons-material/Lock';
import { useGlobalState } from '../state/global';

const ResetPassword: React.FC = () => {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const [password, setPassword] = useState('');
    const [otpToken, setOtpToken] = useState('');
    const [passwordVisible, setPasswordVisible] = useState(false);
    const [loading, setLoading] = useState(false);
    const [snackbar, setSnackbar] = useGlobalState('snackbar');

    const token = searchParams.get('token');

    const handleSubmit = async () => {
        try {
            setLoading(true);
            const payload: { token: string | null; password: string; otp_token?: string } = {
                token,
                password,
            };
            if (otpToken.trim()) payload.otp_token = otpToken.trim();
            const response = await axios.post('/api/emails/do-reset-password', payload);
            // Handle login logic here if needed
            navigate('/');
            window.location.reload();
        } catch (err: any) {
            console.error(err)
            // setError(err.response?.data?.message || 'An error occurred while resetting password');
            setSnackbar({
                open: true,
                severity: 'error',
                message: err.response?.data?.message || 'An error occurred while resetting password',
                duration: null
            });
        } finally {
            setLoading(false);
        }
    };

    return (
        <Grid container direction="column"
            alignItems="center"
            justifyContent="center"
            style={{
                minHeight: '100vh',
                // minWidth: '100vw',
            }}
        >
            <Stack spacing={2} width={"320px"}>
                <Typography variant="h6">Reset Password</Typography>
                <TextField
                    margin="dense"
                    id="new-password"
                    label="New Password"
                    type={!passwordVisible ? "password" : "text"}
                    fullWidth
                    variant="standard"
                    color="warning"
                    value={password}
                    helperText="Keep your password secure!"
                    onChange={(e) => setPassword(e.target.value)}
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
                <TextField
                    margin="dense"
                    id="otp-token"
                    label="Authenticator code (if MFA is enabled)"
                    type="text"
                    fullWidth
                    variant="standard"
                    color="warning"
                    value={otpToken}
                    inputProps={{ inputMode: 'numeric', maxLength: 10 }}
                    autoComplete="one-time-code"
                    onChange={(e) => setOtpToken(e.target.value)}
                />
                <Button
                    type="submit"
                    variant="contained"
                    color="primary"
                    disabled={loading}
                    onClick={handleSubmit}
                >
                    Reset Password
                </Button>
            </Stack>
        </Grid>
    );
};

export default ResetPassword;
