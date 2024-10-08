import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Button, TextField, Container, Typography, Box, Alert
} from '@mui/material';
import axios from 'axios';
import * as webauthn from '@github/webauthn-json';

// Interfaces for API requests and responses
interface StartGroupResponse {
    group_id: string;
    participant_uuid: string;
    registration_challenge: string;
}

interface RegisterWebAuthnResponse {
    group_id: string;
    participant_uuid: string;
    webauthn_credential_id: string;
    token: string;
}

export interface EFMGroupState {
    // displayName: string;
    // participantUuid: string;
    // webauthnCredentialId: string;
    // maxParticipants: number;
    token: string;
}

const EFMStart: React.FC = () => {
    const [displayName, setDisplayName] = useState<string>('');
    const [maxParticipants, setMaxParticipants] = useState<number>(3);
    const [maxParticipantsError, setMaxParticipantsError] = useState<string>('');
    const [errorMessage, setErrorMessage] = useState<string>('');
    const navigate = useNavigate();

    const handleStartGroup = async () => {
        if (!validateInputs()) return;

        try {
            // Step 1: Start the group and get WebAuthn registration challenge
            const startGroupResponse = await axios.post<StartGroupResponse>('/api/efm/start-group', {
                max_participants: maxParticipants
            });

            const { group_id, participant_uuid, registration_challenge } = startGroupResponse.data;
            console.log("new group", group_id, participant_uuid, registration_challenge);

            // Step 2: Use WebAuthn to register the participant
            const credential = await webauthn.create({
                publicKey: JSON.parse(registration_challenge)
            });
            console.log("cred", credential);

            // Step 3: Register WebAuthn credential with the backend
            const registerResponse = await axios.post<RegisterWebAuthnResponse>('/api/efm/register-webauthn', {
                group_id,
                participant_uuid,
                registration_response: credential
            });

            console.log("reg", registerResponse);

            // Step 4: Check if registration was successful and navigate to the group page
            if (registerResponse.status === 200) {
                // Save everything except for the token in localStorage
                localStorage.setItem(`session-${group_id}-name`,
                    displayName);
                localStorage.setItem(`session-${group_id}-max-participants`,
                    maxParticipants.toString());
                localStorage.setItem(`session-${group_id}-participant-uuid`,
                    participant_uuid);
                localStorage.setItem(`session-${group_id}-webauthn-credential-id`,
                    registerResponse.data.webauthn_credential_id);

                // Navigate to the group page
                navigate(`/tools/p2pe2e/${group_id}`, {
                    state: {
                        // displayName,
                        // participantUuid: participant_uuid,
                        // webauthnCredentialId: registerResponse.data.webauthn_credential_id,
                        // maxParticipants,
                        token: registerResponse.data.token,
                    } as EFMGroupState
                });
            } else {
                setErrorMessage('Registration failed. Please try again.');
                console.error('Registration failed');
            }
        } catch (error) {
            setErrorMessage(`Error starting group. ${error}`);
            console.error('Error starting group:', error);
        }
    };

    const validateInputs = (): boolean => {
        if (displayName.trim() === '') {
            setErrorMessage('Display name is required.');
            return false;
        }
        if (isNaN(maxParticipants) || maxParticipants < 1 || maxParticipants > 100) {
            setMaxParticipantsError('Please enter a valid number between 1 and 100.');
            return false;
        }
        setMaxParticipantsError('');
        setErrorMessage('');
        return true;
    };

    const handleKeyPress = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleStartGroup();
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
                    Start DAO Messaging Group
                </Typography>
                <Box
                    component="form"
                    sx={{
                        width: '100%',
                        mt: 1,
                    }}
                    noValidate
                    autoComplete="off"
                    onKeyPress={handleKeyPress}
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
                    />
                    <TextField
                        id="max-participants-input"
                        label="Max Participants"
                        type="number"
                        value={maxParticipants || ''}
                        onChange={(e) => {
                            const value = parseInt(e.target.value, 10);
                            setMaxParticipants(value);
                        }}
                        fullWidth
                        margin="normal"
                        required
                        error={!!maxParticipantsError}
                        helperText={maxParticipantsError}
                        inputProps={{ min: 1, max: 100 }}
                        aria-required="true"
                    />
                    <Button
                        variant="contained"
                        color="primary"
                        sx={{ mt: 3 }}
                        disabled={displayName.trim() === ''}
                        onClick={handleStartGroup}
                    >
                        Start Group
                    </Button>
                </Box>
            </Box>
        </Container>
    );
};

export default EFMStart;
