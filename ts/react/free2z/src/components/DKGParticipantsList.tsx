import { FC, useState } from 'react';
import {
    List,
    ListItem,
    Avatar,
    Box,
    Typography,
    Stack,
    Button,
    Accordion,
    AccordionSummary,
    AccordionDetails,
} from '@mui/material';
import {
    CheckCircle,
    Error,
    Warning,
    Help,
    ContentCopy,
    ExpandMore,
} from '@mui/icons-material';
import { Participant, State } from '../lib/webrtc-state';


function getDTLSFingerprint(peerConnection?: RTCPeerConnection): string {
    if (!peerConnection || peerConnection.signalingState === 'closed') {
        return "N/A";
    }

    const localDescription = peerConnection.localDescription;
    if (localDescription) {
        const sdpLines = localDescription.sdp.split('\n');
        const fingerprintLine = sdpLines.find(line => line.startsWith('a=fingerprint:'));
        if (fingerprintLine) {
            return fingerprintLine.split(' ')[1];
        }
    }

    return "N/A";
}

function getAllConnectionDetails(participant: Participant): JSX.Element {
    const { peerConnection, dataChannel } = participant;

    // type RTCSignalingState = "closed" | "have-local-offer" | "have-local-pranswer" | "have-remote-offer" | "have-remote-pranswer" | "stable";
    if (!peerConnection || peerConnection.signalingState === 'closed') {
        return <Typography variant="body2">No peer connection details available.</Typography>;
    }

    return (
        <Stack spacing={2}>
            <Typography variant="body2">
                <strong>WebSocket State:</strong> {`${participant.websocketState}`}
            </Typography>
            <Typography variant="body2">
                <strong>ICE Connection State:</strong> {peerConnection.iceConnectionState || 'N/A'}
            </Typography>
            <Typography variant="body2">
                <strong>ICE Gathering State:</strong> {peerConnection.iceGatheringState || 'N/A'}
            </Typography>
            <Typography variant="body2">
                <strong>Signaling State:</strong> {peerConnection.signalingState || 'N/A'}
            </Typography>
            <Typography variant="body2">
                <strong>Local Description:</strong> <span style={{ wordBreak: 'break-word' }}>{peerConnection.localDescription?.sdp || 'N/A'}</span>
            </Typography>
            <Typography variant="body2">
                <strong>Remote Description:</strong> <span style={{ wordBreak: 'break-word' }}>{peerConnection.remoteDescription?.sdp || 'N/A'}</span>
            </Typography>

            {dataChannel && (
                <>
                    <Typography variant="body2">
                        <strong>Data Channel State:</strong> {dataChannel.readyState || 'N/A'}
                    </Typography>
                    <Typography variant="body2">
                        <strong>Data Channel Label:</strong> {dataChannel.label || 'N/A'}
                    </Typography>
                    <Typography variant="body2">
                        <strong>Data Channel Buffered Amount:</strong> {dataChannel.bufferedAmount || 0}
                    </Typography>
                </>
            )}
        </Stack>
    );
}


interface DKGParticipantsListProps {
    state: State;
}

const getIceConnectionStateIcon = (state: RTCIceConnectionState): JSX.Element => {
    switch (state) {
        case 'connected':
        case 'completed':
            return <CheckCircle fontSize="small" sx={{ color: 'success.main' }} />;
        case 'disconnected':
        case 'failed':
            return <Error fontSize="small" sx={{ color: 'error.main' }} />;
        case 'checking':
        case 'new':
            return <Warning fontSize="small" sx={{ color: 'warning.main' }} />;
        case 'closed':
            return <Help fontSize="small" sx={{ color: 'text.secondary' }} />;
        default:
            return <Help fontSize="small" sx={{ color: 'text.secondary' }} />;
    }
};

const DKGParticipantsList: FC<DKGParticipantsListProps> = ({ state }) => {
    const [copied, setCopied] = useState(false);

    const handleCopyUrl = () => {
        navigator.clipboard.writeText(window.location.href)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));

        setTimeout(() => setCopied(false), 2000);
    };

    const otherParticipants = Object.values(state.participants).filter(
        (participant) => participant.uuid !== state.participant_uuid
    );

    if (otherParticipants.length === 0) {
        return (
            <Box textAlign="center" my={4} component="div">
                <Typography variant="body1" color="text.secondary">
                    No participants yet. Share this URL with people you trust to start a private chat.
                </Typography>
                <Button
                    variant="contained"
                    color="primary"
                    startIcon={<ContentCopy />}
                    onClick={handleCopyUrl}
                    sx={{ mt: 2 }}
                >
                    {copied ? 'Copied!' : 'Copy URL'}
                </Button>
            </Box>
        );
    }

    return (
        <List
            sx={{
                padding: 0,
            }}
        >
            {otherParticipants.map((participant) => (
                <Accordion key={participant.uuid} sx={{ width: '100%', height: '100%' }}>
                    <AccordionSummary expandIcon={<ExpandMore />} aria-controls={`panel-${participant.uuid}-content`}>
                        <ListItem
                            disablePadding
                            sx={{
                                width: '100%',
                                padding: 0,
                            }}
                        >
                            <Stack direction="row"
                                alignItems="center"
                                justifyContent="center"
                                spacing={2} sx={{ width: '100%' }}>
                                <Avatar sx={{ bgcolor: 'primary.main' }}>
                                    {participant.name?.slice(0, 1) || '?'}
                                </Avatar>
                                <Stack sx={{ flexGrow: 1 }} direction="column">
                                    <Typography variant="body1">
                                        {participant.name || participant.uuid}
                                    </Typography>
                                    <Stack direction="row" alignItems="center" spacing={1}>

                                        <Typography variant="caption" color="text.secondary">
                                            <b>WebSocket</b>
                                        </Typography>
                                        {participant.websocketState ?
                                            <CheckCircle
                                                fontSize="small"
                                                sx={{ color: 'success.main' }} /> :
                                            <Error
                                                fontSize="small"
                                                sx={{ color: 'error.main' }}
                                            />
                                        }
                                        <Typography variant="caption" color="text.secondary">
                                            <b>ICE</b>
                                        </Typography>
                                        {getIceConnectionStateIcon(participant.peerConnection?.iceConnectionState || 'new')}
                                        <Typography variant="caption" color="text.secondary">
                                            <b>Channel</b>
                                        </Typography>
                                        {participant.dataChannel?.readyState === "open" ?
                                            <CheckCircle
                                                fontSize="small"
                                                sx={{ color: 'success.main' }} /> :
                                            <Error
                                                fontSize="small"
                                                sx={{ color: 'error.main' }}
                                            />
                                        }
                                    </Stack>

                                    <Typography variant="caption" color="text.secondary">
                                        <b>UUID:</b> {participant.uuid || 'N/A'}
                                    </Typography>
                                    <Typography variant="caption" color="text.secondary" sx={{
                                        // breakword
                                        wordBreak: 'break-word',
                                    }}>
                                        <b>Fingerprint:</b> {getDTLSFingerprint(participant.peerConnection) || 'N/A'}
                                    </Typography>
                                </Stack>
                            </Stack>
                        </ListItem>
                    </AccordionSummary>
                    <AccordionDetails>
                        {getAllConnectionDetails(participant)}
                    </AccordionDetails>
                </Accordion>

            ))}
        </List>
    );
};

export default DKGParticipantsList;
