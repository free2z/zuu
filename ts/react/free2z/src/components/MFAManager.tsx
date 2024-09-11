import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import {
    Button, Dialog, DialogActions, DialogContent, DialogTitle,
    Stack, TextField, CircularProgress, Alert, Popover, Typography, Link, useMediaQuery, Theme, Paper,
} from '@mui/material';
import QRCode from 'react-qr-code';
import { useGlobalState } from '../state/global';
import CopyToClipboard from './CopyToClipboard';

interface MFADetails {
    enabled: boolean;
    otp_uri?: string;
    secret?: string;
}

const MFAManager: React.FC = () => {
    const [open, setOpen] = useState(false);
    const [token, setToken] = useState('');
    const queryClient = useQueryClient();
    const [snackbar, setSnackbar] = useGlobalState('snackbar');

    const isXS = useMediaQuery((theme: Theme) => theme.breakpoints.down('sm'));


    // Fetch MFA status
    const { data: mfaDetails, isLoading: isLoadingStatus, error: statusError } = useQuery<MFADetails>('mfaStatus', () =>
        axios.get('/api/otp/status/').then(res => res.data)
    );

    // Setup MFA
    const { mutate: setupMFA, isLoading: isSettingUp, error: setupError } = useMutation(() => axios.post('/api/otp/setup/'), {
        onSuccess: (response) => {
            setOpen(true);
            queryClient.setQueryData('mfaStatus', (oldData: any) => ({
                ...oldData,
                otp_uri: response.data.otp_uri,
                secret: response.data.secret,
            }));
        }
    });

    // Verify MFA setup
    const { mutate: verifyMFA, isLoading: isVerifying, error: verifyError } = useMutation(() => axios.post('/api/otp/enable/', { token }), {
        onSuccess: () => {
            setOpen(false);
            queryClient.setQueryData('mfaStatus', { enabled: true });
        }
    });

    // Disable MFA
    const { mutate: disableMFA, isLoading: isDisabling, error: disableError } = useMutation(() => axios.delete('/api/otp/disable/'), {
        onSuccess: () => {
            queryClient.setQueryData('mfaStatus', { enabled: false });
        }
    });

    const handleSetupClick = () => {
        setupMFA();
    };

    const handleVerifyClick = () => {
        verifyMFA();
    };

    const handleDisableClick = () => {
        disableMFA();
    };

    const handleDialogClose = () => {
        setOpen(false);
    };

    const errorMessage = (error: unknown) => {
        return (error as Error).message || 'An unknown error occurred';
    };


    const [anchorEl, setAnchorEl] = useState<HTMLAnchorElement | null>(null);

    const handleCopy = (event: React.MouseEvent<HTMLAnchorElement>) => {
        setAnchorEl(event.currentTarget);
        // your copy logic here
    };

    const handleClose = () => {
        // closes the copied popover
        setAnchorEl(null);
    };

    const { data: passwordIsSetData, isLoading: passwordIsSetLoading } = useQuery('passwordIsSet', () =>
        axios.get('/api/emails/password-is-set')
    );

    const passwordIsSet = passwordIsSetData?.data?.password_set;

    const popen = Boolean(anchorEl);
    const id = popen ? 'simple-popover' : undefined;

    useEffect(() => {
        if (token.length === 6) {
            handleVerifyClick();
        }
    }, [token])

    if (!passwordIsSet && !passwordIsSetLoading) {
        return (
            <Alert severity="warning">You must set a password before setting up Multi-Factor Auth!</Alert>
        );
    }

    return (
        <div>
            {isLoadingStatus ? (
                <CircularProgress />
            ) : statusError ? (
                <Alert severity="error">Error fetching MFA status: {errorMessage(statusError)}</Alert>
            ) : mfaDetails?.enabled ? (
                <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={2} alignItems="center" justifyContent="center"
                >
                    <Alert severity="success">Multi-Factor Auth (MFA) enabled!</Alert>
                    <Button variant="text" color="warning" onClick={handleDisableClick} disabled={isDisabling}>
                        Disable
                    </Button>
                </Stack>
            ) : (
                <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={2} alignItems="center" justifyContent="center"
                >
                    <Alert severity="warning">No Multi-Factor Auth (MFA)!</Alert>
                    <Button variant="contained" color="primary" onClick={handleSetupClick} disabled={isSettingUp}>
                        Setup MFA
                    </Button>
                </Stack>
            )
            }

            <Dialog open={open} onClose={handleDialogClose} maxWidth="md"
                fullScreen={isXS}
            >
                <DialogTitle>Set up MFA</DialogTitle>
                <DialogContent>
                    <Stack direction="column" spacing={2} alignItems="center" justifyContent="center">
                        {isSettingUp ? (
                            <CircularProgress />
                        ) : setupError ? (
                            <Alert severity="error">Error setting up MFA: {errorMessage(setupError)}</Alert>
                        ) : (
                            <>
                                <CopyToClipboard>
                                    {({ copy }) => (
                                        <>
                                            <Typography variant='caption'>Tap or Scan</Typography>
                                            <Paper
                                                sx={{
                                                    background: "white",
                                                    padding: "1em",
                                                    lineHeight: "0",
                                                    // width: `290px`,
                                                    // margin: "auto",
                                                }}
                                                elevation={10}
                                            >
                                                <Link href={mfaDetails?.otp_uri}
                                                    onClick={(e) => {
                                                        // setAnchorEl(e.currentTarget);
                                                        // e.preventDefault()
                                                        handleCopy(e);
                                                        copy(mfaDetails?.secret || '')
                                                        console.log(mfaDetails)
                                                        // window.open(mfaDetails?.otp_uri, "_blank")
                                                        setTimeout(() => {
                                                            handleClose();
                                                        }, 2000);
                                                    }}
                                                >
                                                    <QRCode
                                                        style={{
                                                            width: "280px",
                                                        }}
                                                        value={mfaDetails?.otp_uri || ''}
                                                    />
                                                </Link>
                                            </Paper>
                                            <TextField
                                                label="Verification Code"
                                                value={token}
                                                onChange={(e) => {
                                                    setToken(e.target.value);
                                                }}
                                                fullWidth
                                                margin="normal"
                                                disabled={isVerifying}
                                            />
                                        </>
                                    )}
                                </CopyToClipboard>
                                <Popover
                                    id={id}
                                    open={popen}
                                    anchorEl={anchorEl}
                                    onClose={handleClose}
                                    anchorOrigin={{
                                        vertical: 'center',
                                        horizontal: 'center',
                                    }}
                                    transformOrigin={{
                                        vertical: 'top',
                                        horizontal: 'center',
                                    }}
                                >
                                    <Typography sx={{ p: 2 }}>Copied!</Typography>
                                </Popover>
                            </>
                        )}
                        {verifyError ? (
                            <Alert severity="error">Error verifying MFA</Alert>
                        ) : <></>}
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={handleDialogClose}>Cancel</Button>
                    <Button onClick={handleVerifyClick} color="primary" disabled={isVerifying}>
                        Verify
                    </Button>
                </DialogActions>
            </Dialog>

            {isVerifying && <CircularProgress />}
            {
                disableError ? (
                    <Alert severity="error">Error disabling MFA</Alert>
                ) : <></>
            }
        </div >
    );
};

export default MFAManager;
