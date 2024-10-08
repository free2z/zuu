import React, { useState } from 'react';
import { Box, TextField, Button, Container, Typography, Alert } from '@mui/material';
import axios from 'axios';
import * as webauthn from '@github/webauthn-json';
import { Action } from '../lib/webrtc-state';

interface EFMNewParticipantProps {
    UUID: string;
    dispatch: React.Dispatch<Action>;
}

interface RegisterParticipantResponse {
    group_id: string;
    participant_uuid: string;
    registration_challenge: string;
}

interface RegisterWebAuthnResponse {
    group_id: string;
    participant_uuid: string;
    webauthn_credential_id: string;
    token: string;
    n: number;
}

interface ErrorResponse {
    data: {
        error: string;
    };
}


const EFMNewParticipant: React.FC<EFMNewParticipantProps> = ({ UUID, dispatch }) => {
    const [displayName, setDisplayName] = useState<string>('');
    const [errorMessage, setErrorMessage] = useState<string>('');

    const handleRegisterParticipant = async () => {
        if (!displayName.trim()) {
            setErrorMessage('Display name is required.');
            return;
        }

        try {
            // Step 1: Register the participant and get the WebAuthn registration challenge
            const response = await axios.post<RegisterParticipantResponse>('/api/efm/register-participant', {
                name: displayName,
                group_id: UUID,
            });

            const { participant_uuid, registration_challenge } = response.data;
            console.log("register participant", UUID, participant_uuid, registration_challenge);

            // Step 2: Use WebAuthn to register the participant
            const credential = await webauthn.create({
                publicKey: JSON.parse(registration_challenge),
            });
            console.log("cred", credential);

            // Step 3: Register WebAuthn credential with the backend
            const registerResponse = await axios.post<RegisterWebAuthnResponse>('/api/efm/register-webauthn', {
                group_id: UUID,
                participant_uuid,
                registration_response: credential,
            });

            console.log("reg", registerResponse);

            // Step 4: Check if registration was successful and update state
            if (registerResponse.status === 200) {
                // Save everything except for the token in localStorage
                localStorage.setItem(`session-${UUID}-name`, displayName);
                localStorage.setItem(`session-${UUID}-participant-uuid`, participant_uuid);
                localStorage.setItem(`session-${UUID}-webauthn-credential-id`, registerResponse.data.webauthn_credential_id);

                // Dispatch actions to update the global state
                dispatch({ type: 'SET_NAME', payload: displayName });
                dispatch({ type: 'SET_PARTICIPANT_UUID', payload: participant_uuid });
                dispatch({ type: 'SET_TOKEN', payload: registerResponse.data.token });
                dispatch({ type: 'SET_N', payload: registerResponse.data.n });

                // We do not navigate; state update will handle the flow
            } else {
                setErrorMessage('Registration failed. Please try again.');
                console.error('Registration failed');
            }
        } catch (error: unknown) {
            console.error('Error registering participant:', error);
            const e = error as ErrorResponse;
            const msg = e?.data?.error;
            if (msg) {
                setErrorMessage(`Error: ${msg}`);
            } else {
                setErrorMessage('An error occurred. Please try again.');
            }
        }
    };

    return (
        <Container maxWidth="sm">
            <Box
                sx={{
                    display: 'flex',
                    flexDirection: 'column',
                    mt: 4,
                    mb: 4,
                }}
                component="div"
            >
                <Typography variant="h4" component="h1" gutterBottom>
                    Join DAO Messaging Group
                </Typography>
                <Box
                    component="form"
                    sx={{
                        width: '100%',
                        mt: 1,
                    }}
                    noValidate
                    autoComplete="off"
                >
                    {errorMessage && <Alert severity="error">{errorMessage}</Alert>}
                    <TextField
                        id="display-name-input"
                        label="Your Display Name"
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        fullWidth
                        margin="normal"
                        required
                        aria-required="true"
                        autoFocus
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                e.preventDefault();
                                handleRegisterParticipant();
                            }
                        }}
                    />
                    <Button
                        variant="contained"
                        color="primary"
                        sx={{ mt: 3 }}
                        disabled={displayName.trim() === ''}
                        onClick={handleRegisterParticipant}
                    >
                        Join Group
                    </Button>
                </Box>
            </Box>
        </Container>
    );
};

export default EFMNewParticipant;
