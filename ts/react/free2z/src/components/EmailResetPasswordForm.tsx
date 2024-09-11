import { useState } from "react";
import { Stack, Typography, TextField, Button, useMediaQuery, useTheme } from "@mui/material";
import { useGlobalState } from "../state/global";
// import { useNavigate } from "react-router-dom";
import axios from "axios";


export default function EmailResetPasswordForm() {
    const [email, setEmail] = useState('')
    const [isAddingEmail, setIsAddingEmail] = useState(false)
    const [snackbar, setSnackbar] = useGlobalState('snackbar');
    const theme = useTheme();
    const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

    const handleEmailSubmit = async () => {
        setIsAddingEmail(true);
        try {
            // Replace with your actual API endpoint
            const response = await axios.post('/api/emails/reset-password', { email });
            // Handle success response
            setSnackbar({ open: true, message: 'Reset email sent successfully!', severity: 'success', duration: 3000 });
            // navigate(-1); // Go back to the previous page
        } catch (error) {
            // Handle error response
            setSnackbar({ open: true, message: "Failed! Maybe that's not a confirmed email?", severity: 'error', duration: null });
        } finally {
            setIsAddingEmail(false);
        }
    };

    return (
        <Stack direction="column" spacing={1} style={{ padding: theme.spacing(2) }}>
            <Typography variant="caption"
                style={{ color: theme.palette.text.secondary }}
            >
                If you have confirmed an email, you can reset your password by sending yourself a link here.
            </Typography>
            <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={1} alignItems="center" justifyContent="center"
            >
                <TextField
                    label="Email"
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    variant="outlined"
                    margin="normal"
                    size="small"
                    // fullWidth
                    style={{
                        // wi
                        // margin: theme.spacing(1),
                        // flexGrow: 1,
                        minWidth: 320,
                        backgroundColor: theme.palette.background.paper,
                        color: theme.palette.text.primary
                    }}
                />
                <Button
                    variant="contained"
                    onClick={() => handleEmailSubmit()}
                    disabled={isAddingEmail}
                    sx={{
                        // padding: theme.spacing(1),
                        backgroundColor: theme.palette.primary.main,
                        color: theme.palette.primary.contrastText,
                    }}
                >
                    Send Reset Email
                </Button>
            </Stack>
        </Stack>
    );

}
