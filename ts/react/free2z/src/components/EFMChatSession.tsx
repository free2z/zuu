import React, { useEffect, useRef, useState } from 'react';
import { Box, Container } from '@mui/material';
import { WebRTCManager } from '../lib/p2pe2e/webrtcmanager';
import { Action, State } from '../lib/webrtc-state';
import DKGMessages from './DKGMessages';
import DKGSendMessage from './DKGSendMessage';
import SessionOverview from './DKGSessionOverview';
import ConfigurationDrawer from './DKGConfigurationDrawer';

interface EFMChatSessionProps {
    UUID: string;
    state: State;
    dispatch: React.Dispatch<Action>;
}

const EFMChatSession: React.FC<EFMChatSessionProps> = ({ UUID, state, dispatch }) => {
    const managerRef = useRef<WebRTCManager | null>(null);
    const [drawerOpen, setDrawerOpen] = useState(false);

    useEffect(() => {
        if (state.token && !managerRef.current) {
            const manager = new WebRTCManager(UUID, state, dispatch);
            manager.initialize();
            managerRef.current = manager;
        }
    }, [UUID, state.token, dispatch]);

    const handleNameSubmit = (name: string) => {
        if (managerRef.current) {
            managerRef.current.changeName(name);
        }
        dispatch({ type: 'SET_NAME', payload: name });
    };

    const handleStartDKG = () => {
        // Logic to start the FROST DKG
        console.log("Starting FROST DKG...");
        setDrawerOpen(false);
    };

    return (
        <Container
            maxWidth="lg"
            sx={{
                height: '100vh',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                padding: 0,
                margin: "0 auto",
            }}
        >
            <Box component="div">
                <SessionOverview state={state} onOpenDrawer={() => setDrawerOpen(true)} />
                <ConfigurationDrawer
                    open={drawerOpen}
                    onClose={() => setDrawerOpen(false)}
                    initialName={state.name}
                    onChangeName={handleNameSubmit}
                    onStartDKG={handleStartDKG}
                />
            </Box>
            <Box sx={{
                display: 'flex',
                flexDirection: 'column',
                flex: 1,
                overflow: 'hidden',
            }}
                component="main"
            >
                <Box
                    sx={{
                        flex: 1,
                        overflowY: 'auto',
                    }}
                    component="div"
                >
                    <DKGMessages state={state} />
                </Box>
                {managerRef.current && (
                    <Box component="div">
                        <DKGSendMessage
                            state={state}
                            manager={managerRef.current}
                        />
                    </Box>
                )}
            </Box>
        </Container>
    );
};

export default EFMChatSession;
