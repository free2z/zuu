import { useState } from 'react';
import axios, { AxiosResponse } from 'axios';
import { useMutation, useQuery } from 'react-query';
import CircularProgress from '@mui/material/CircularProgress';
import { Grid } from '@mui/material';
import { useGlobalState } from '../state/global';
import { AlertColor } from '@mui/material/Alert';
import { EmailConfirmationNoEmail } from './EmailConfirmationNoEmail';
import EmailConfirmationPending from './EmailConfirmationPending';
import { EmailConfirmationConfirmed } from './EmailConfirmationConfirmed';

export interface EmailStatus {
    email: string | null;
    confirmed: boolean;
    pending: boolean;
    is_public: boolean;
    get_notifications: boolean;
}

export default function EmailConfirmationLink() {
    const [isEditing, setIsEditing] = useState(false);
    const [snackbar, setSnackbar] = useGlobalState("snackbar");

    const updateSnackbar = (message: string, severity: AlertColor) => {
        setSnackbar({ open: true, message, severity, duration: 6000 });
    };

    // Fetch email status
    const { data: emailStatus, refetch, isLoading: isFetching } = useQuery<EmailStatus>('emailStatus', () =>
        axios.get('/api/emails/status').then(res => res.data)
    );

    // Add email mutation
    const { mutate: addEmail, isLoading: isAddingEmail } = useMutation(
        (newEmail: string) => axios.post('/api/emails/add', { email: newEmail }),
        {
            onSuccess: () => {
                refetch();
                setIsEditing(false);
                updateSnackbar("Email added successfully", "success");
            },
            onError: (err) => {
                console.log(err);
                const error = err as AxiosResponse;
                updateSnackbar(`Error: ${JSON.stringify(error.data)}`, "error");
            }
        }
    );

    const { mutate: resendEmail, isLoading: isResendingEmail } = useMutation(
        (newEmail: string) => axios.post('/api/emails/resend', { email: newEmail }),
        {
            onSuccess: () => {
                refetch();
                updateSnackbar("Confirmation email resent successfully", "success");
            },
            onError: (err) => {
                console.log(err);
                const error = err as AxiosResponse;
                updateSnackbar(`Error: ${JSON.stringify(error.data)}`, "error");
            }
        }
    );

    const handleEmailSubmit = (email: string) => {
        addEmail(email);
    };

    const isConfirmed = emailStatus?.confirmed && !isEditing && !isFetching;
    const isPending = emailStatus?.pending && !isFetching;
    const noEmail = (isEditing || emailStatus?.email === null) && !isFetching;

    let content = null;
    if (isFetching) return <CircularProgress />
    if (noEmail) {
        // console.log("NO EMAIL", emailStatus);
        content = <EmailConfirmationNoEmail
            handleEmailSubmit={handleEmailSubmit}
            isAddingEmail={isAddingEmail}
        />
    }
    if (isPending) {
        // console.log("PENDING", emailStatus);
        content = <EmailConfirmationPending
            emailStatus={emailStatus}
            resend={() => {
                emailStatus.email && resendEmail(emailStatus.email)
            }}
            refetch={refetch}
        />
    }
    if (isConfirmed) {
        // console.log("CONFIRMED", emailStatus);
        content = <EmailConfirmationConfirmed
            emailStatus={emailStatus}
            refetch={refetch}
        />
    }

    // console.log("EMAIL STATUS", emailStatus)

    return (
        <Grid
            container
            spacing={{ xs: 1, sm: 3 }}
            alignItems="center"
            justifyContent={{ xs: 'center', sm: 'space-around' }}
        // textAlign={{ xs: 'center', sm: 'left' }}
        >
            {content}
        </Grid>
    );
}
