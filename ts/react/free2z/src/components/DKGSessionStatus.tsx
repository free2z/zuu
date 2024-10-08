import React, { useState } from 'react';
import { Box, Typography, Tooltip, Drawer } from '@mui/material';
import {
    CheckCircle,
    CheckCircleOutline,
    ErrorOutline,
    HourglassEmpty,
    InfoOutlined,
} from '@mui/icons-material';
import { Participant, State } from '../lib/webrtc-state';
import DKGParticipantsList from './DKGParticipantsList';

interface SessionStatusProps {
    state: State;
}

const DKGSessionStatus: React.FC<SessionStatusProps> = ({ state }) => {
    const [drawerOpen, setDrawerOpen] = useState(false);

    const otherParticipants = Object.values(state.participants).filter(
        (participant) => participant.uuid !== state.participant_uuid
    );

    // Check if a participant has a valid peer connection and it's in a good state
    const isPeerConnectionStable = (participant: Participant) =>
        participant.peerConnection &&
        (
            participant.peerConnection?.iceConnectionState === 'connected' ||
            participant.peerConnection?.iceConnectionState === 'completed'
        )
        && participant.peerConnection?.signalingState === 'stable' &&
        participant.peerConnection?.connectionState === 'connected' &&
        participant.dataChannel?.readyState === 'open';

    // All participants are fully connected (WebSocket + PeerConnection)
    const allParticipantsFullyConnected = otherParticipants.every(
        participant =>
            participant.websocketState && isPeerConnectionStable(participant)
    );

    // Check for any connection issues (either WebSocket or ICE failure)
    const hasConnectionIssues = otherParticipants.some(
        participant =>
            !participant.websocketState || participant.peerConnection?.iceConnectionState === 'failed'
    );

    // There are participants present
    const hasParticipants = otherParticipants.length > 0;
    const allWebSocketsConnected = otherParticipants.every(
        participant => participant.websocketState
    );

    // Default status values
    let statusIcon = <InfoOutlined color="info" />;
    let statusTooltip = "Status Unknown";
    let statusColor: 'success' | 'primary' | 'warning' | 'error' | 'disabled' | 'info' = 'info';

    // Update status based on the actual state of WebSocket and peer connections
    if (!hasParticipants) {
        statusIcon = <HourglassEmpty color="disabled" />;
        statusTooltip = "Waiting for Participants";
        statusColor = 'disabled';
    } else if (allParticipantsFullyConnected && state.n === Object.keys(state.participants).length) {
        statusIcon = <CheckCircle color="success" />;
        statusTooltip = "All Participants Fully Connected";
        statusColor = 'success';
    } else if (allWebSocketsConnected) {
        statusIcon = <CheckCircleOutline color="primary" />;
        statusTooltip = "All Present Participants Connected (WebSocket only)";
        statusColor = 'primary';
    } else if (hasConnectionIssues) {
        statusIcon = <ErrorOutline color="warning" />;
        statusTooltip = "Some Connection Issues Detected";
        statusColor = 'warning';
    }

    statusTooltip += ` (${Object.keys(state.participants).length}/${state.n})`;

    const handleDrawerToggle = () => {
        setDrawerOpen(!drawerOpen);
    };

    return (
        <>
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    cursor: 'pointer',
                    color: statusColor,
                }}
                component="div"
                onClick={handleDrawerToggle}
            >
                <Tooltip title={statusTooltip}>
                    {statusIcon}
                </Tooltip>
                <Typography variant="body1" sx={{ ml: 1 }}>
                    {state.participant_uuid.slice(0, 5)}: {state.name}
                </Typography>
            </Box>

            <Drawer
                anchor="bottom"
                open={drawerOpen}
                onClose={handleDrawerToggle}
            >
                <DKGParticipantsList state={state} />
            </Drawer>
        </>
    );
};

export default DKGSessionStatus;
