import React, { useEffect, useReducer } from 'react';
import { useParams, useLocation } from 'react-router-dom';
import { EFMGroupState } from './EFMStart';
import EFMNewParticipant from './EFMNewParticipant';
import EFMReauthenticate from './EFMReauthenticate';
import EFMChatSession from './EFMChatSession';
import { Alert } from '@mui/material';
import { initialState, reducer } from '../lib/webrtc-state';


const EFMMainSession: React.FC = () => {
    const { UUID } = useParams<{ UUID: string }>();
    const location = useLocation();
    const savedState = location.state as EFMGroupState | null;

    // Initialize state from local storage or passed state
    const [state, dispatch] = useReducer(reducer, {
        ...initialState,
        name: localStorage.getItem(`session-${UUID}-name`) || '',
        participant_uuid: localStorage.getItem(`session-${UUID}-participant-uuid`) || '',
        webauthn_credential_id: localStorage.getItem(`session-${UUID}-webauthn-credential-id`) || '',
        n: parseInt(
            localStorage.getItem(`session-${UUID}-max-participants`) || '0'
        ),
        token: savedState?.token || '',
    });

    const [errorMessage, setErrorMessage] = React.useState<string>('');
    const [status, setStatus] = React.useState<'initial' | 'new' | 'reauth' | 'authenticated'>('initial');

    useEffect(() => {
        if (!UUID) {
            setErrorMessage('Invalid session. Please provide a valid group UUID.');
            return;
        }

        // Determine the current status based on the state
        if (!state.participant_uuid && !state.token) {
            setStatus('new');
        } else if (state.participant_uuid && !state.token) {
            setStatus('reauth');
        } else if (state.participant_uuid && state.token) {
            setStatus('authenticated');
        }
    }, [UUID, state.participant_uuid, state.token]); // Dependencies only necessary states

    if (errorMessage) {
        return <Alert severity="error">{errorMessage}</Alert>;
    }

    // Render based on the current status
    switch (status) {
        case 'new':
            return <EFMNewParticipant UUID={UUID!} dispatch={dispatch} />;
        case 'reauth':
            return <EFMReauthenticate UUID={UUID!} state={state} dispatch={dispatch} />;
        case 'authenticated':
            return <EFMChatSession UUID={UUID!} state={state} dispatch={dispatch} />;
        default:
            return null;
    }
};

export default EFMMainSession;
