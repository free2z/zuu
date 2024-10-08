import React from 'react';
import { Box, IconButton, Badge } from '@mui/material';
import SettingsIcon from '@mui/icons-material/Settings';
import { State } from '../lib/webrtc-state';
import SessionStatus from './DKGSessionStatus';

interface SessionOverviewProps {
    state: State;
    onOpenDrawer: () => void;
}

const SessionOverview: React.FC<SessionOverviewProps> = ({ state, onOpenDrawer }) => {
    return (
        <Box
            sx={{
                padding: 1,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                // BorderBottom: '1px solid #ddd',
            }}
            component="div"
        >
            <SessionStatus
                state={state}
            />
            <IconButton onClick={onOpenDrawer}>
                <Badge color="secondary">
                    <SettingsIcon />
                </Badge>
            </IconButton>
        </Box>
    );
};

export default SessionOverview;
