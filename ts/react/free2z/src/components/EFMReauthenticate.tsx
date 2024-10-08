import React, { useState } from 'react';
import axios from 'axios';
import { Backdrop, CircularProgress, Button, Box } from '@mui/material';
import * as webauthn from '@github/webauthn-json';
import { Action, State } from '../lib/webrtc-state';
import { PublicKeyCredentialRequestOptionsJSON } from '@github/webauthn-json/dist/types/basic/json';

interface EFMReauthenticateProps {
    UUID: string;
    state: State;
    dispatch: React.Dispatch<Action>;
}

interface CreateAuthenticationChallengeResponse {
    group_id: string;
    participant_uuid: string;
    authentication_challenge: string;
}

interface AuthenticateWebAuthnResponse {
    group_id: string;
    participant_uuid: string;
    token: string;
    n: number;
}

const EFMReauthenticate: React.FC<EFMReauthenticateProps> = ({ UUID, state, dispatch }) => {
    const [errorMessage, setErrorMessage] = useState<string>('');
    const [isAuthenticating, setIsAuthenticating] = useState<boolean>(false);

    const handleReauthentication = async () => {
        setIsAuthenticating(true);
        try {
            const participantUuid = localStorage.getItem(`session-${UUID}-participant-uuid`);
            const webauthnCredentialId = localStorage.getItem(`session-${UUID}-webauthn-credential-id`);

            if (!participantUuid || !webauthnCredentialId) {
                throw new Error("Missing participant UUID or WebAuthn credential ID.");
            }

            const challengeResponse = await axios.post<CreateAuthenticationChallengeResponse>(
                '/api/efm/create-authentication-challenge',
                {
                    group_id: UUID,
                    participant_uuid: participantUuid,
                }
            );

            const { authentication_challenge } = challengeResponse.data;

            const credential = await webauthn.get({
                publicKey: JSON.parse(authentication_challenge) as PublicKeyCredentialRequestOptionsJSON
            });

            const authResponse = await axios.post<AuthenticateWebAuthnResponse>('/api/efm/authenticate-webauthn', {
                group_id: UUID,
                participant_uuid: participantUuid,
                authentication_response: credential
            });

            const { token, n } = authResponse.data;
            dispatch({ type: 'SET_TOKEN', payload: token });
            dispatch({ type: 'SET_N', payload: n });
            setIsAuthenticating(false);

        } catch (error) {
            console.error("Reauthentication failed:", error);
            setErrorMessage('Reauthentication failed. Please try again.');
            setIsAuthenticating(false);
        }
    };

    return (
        <Box
            component="div"
            display="flex"
            justifyContent="center"
            alignItems="center"
            minHeight="100vh"
        >
            {isAuthenticating && (
                <Backdrop open={true} style={{ zIndex: 9999 }}>
                    <CircularProgress color="inherit" />
                </Backdrop>
            )}
            {!isAuthenticating && (
                <Button
                    variant="contained" color="primary"
                    onClick={handleReauthentication}
                >
                    Reauthenticate
                </Button>
            )}
            {errorMessage && !isAuthenticating && (
                <div>{errorMessage}</div>
            )}
        </Box>
    );
};

export default EFMReauthenticate;
