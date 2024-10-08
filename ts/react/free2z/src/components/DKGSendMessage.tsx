import React, { useState } from 'react';
import {
    Box, TextField, Button,
    SelectChangeEvent,
    Container
} from '@mui/material';
import { WebRTCManager } from '../lib/p2pe2e/webrtcmanager';
import { State } from '../lib/webrtc-state';

interface DKGSendMessageProps {
    manager: WebRTCManager;
    state: State;
}

const DKGSendMessage: React.FC<DKGSendMessageProps> = ({ manager, state }) => {
    const [message, setMessage] = useState('');
    const [recipients, setRecipients] = useState<string[]>([]);

    const handleSendMessage = () => {
        // TODO: can send to subset of participants
        // Get all participant numbers from the hashmap if no recipients are defined
        const targetRecipients = recipients.length > 0
            ? recipients
            : Object.keys(state.participants).map(String);

        if (message.trim() && targetRecipients.length > 0) {
            manager.sendWebRTC(message, targetRecipients);
            setMessage(''); // Clear the input after sending
        }
    };

    return (
        <Box
            sx={{
                // position: 'fixed',
                bottom: 0,
                left: 0,
                width: '100%',
            }}
            component="div"
        >
            <Container
                maxWidth="xl"
                sx={{
                    margin: 'auto',
                    // border: '1px solid #ddd',
                    display: 'flex',
                    alignItems: 'center',
                    p: 2,
                    // backgroundColor: '#fff',
                    gap: 2
                }}
            // disabled={!Object.keys(state.participants).length}
            >
                <TextField
                    // !Object.keys(state.participants).length
                    disabled={Object.keys(state.participants).length < 2}
                    label="Type your message"
                    value={message}
                    onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
                        setMessage(e.target.value);
                    }}
                    onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) => {
                        const isMobile = /Mobi|Android/i.test(navigator.userAgent);
                        if (!isMobile && e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault(); // Prevent a new line from being added
                            handleSendMessage();
                        }
                    }}
                    variant="outlined"
                    fullWidth
                    multiline
                    minRows={1}
                    maxRows={10}
                    sx={{ flexGrow: 1 }}
                    autoFocus
                />
                <Button
                    variant="contained"
                    color="primary"
                    onClick={handleSendMessage}
                    // TODO: actually check connection state better
                    disabled={!message.trim() || Object.keys(state.participants).length < 2}
                >
                    Send
                </Button>
            </Container>
        </Box>
    );
};

export default DKGSendMessage;
