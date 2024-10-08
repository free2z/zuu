import { Message, Action, State, Participant } from "../webrtc-state";
import { DataChannelManager } from "./datachannelmanager";
import { PeerConnectionManager } from "./peerconnectionmanager";
import { WebSocketManager, WebSocketMessage } from "./websocketmanager";


export class WebRTCManager {
    UUID: string;
    token: string;
    participantUUID: string;
    name: string;
    dispatch: React.Dispatch<Action>;
    wsManager: WebSocketManager;
    dcManager: DataChannelManager;
    private pcManager: PeerConnectionManager;

    constructor(UUID: string, state: State, dispatch: React.Dispatch<Action>) {
        this.participantUUID = state.participant_uuid;
        this.name = state.name;
        this.token = state.token;

        this.UUID = UUID;
        this.dispatch = dispatch;

        this.wsManager = new WebSocketManager(this);
        this.pcManager = new PeerConnectionManager(this);
        this.dcManager = new DataChannelManager(this);
    }

    initialize(): void {
        this.wsManager.initialize();
    }

    close(): void {
        this.wsManager.close();
        this.dcManager.closeDataChannels();
    }

    reconcilePeerConnections(newParticipants: Record<string, Participant>): void {
        const currentConnections = this.pcManager.getActiveConnections();
        const currentParticipantUUIDs = Object.keys(currentConnections);
        const newParticipantUUIDs = Object.keys(newParticipants);

        console.log('Reconciling peer connections:', {
            currentConnections,
            currentParticipantUUIDs,
            newParticipantUUIDs,
        });

        // Do we need to do anything for lost participants?
        // // Close connections for participants who are no longer connected or present
        currentParticipantUUIDs.forEach((uuid) => {
            console.log('Checking participant to close connection:', {
                uuid, participant: currentConnections[uuid],
            });
            if (!newParticipants[uuid] || !newParticipants[uuid].websocketState) {
                this.pcManager.closeConnection(uuid);
                this.dispatch({
                    type: 'SET_WEBSOCKET_STATE',
                    payload: { uuid, state: newParticipants[uuid].websocketState || false }
                })
            }
        });

        // Create or update connections for new and existing participants, only if they are connected
        newParticipantUUIDs.forEach((uuid) => {
            const participant = newParticipants[uuid];
            const isSelf = uuid === this.participantUUID;
            const isPresent = participant.websocketState === true;

            if (!isSelf && isPresent) {
                if (!currentConnections[uuid]) {
                    this.pcManager.createPeerConnection(uuid);
                } else {
                    this.pcManager.updatePeerConnection(uuid);
                }
            }
        });
    }

    handleSignalingMessage(message: WebSocketMessage): void {
        console.log('Handling signaling message:', message);
        this.pcManager.handleSignalingMessage(message);
    }

    sendWebRTC(content: string, recipients: string[]): void {
        console.warn('Sending WebRTC message to recipients:', { recipients });

        const message: Message = {
            content,
            sender: {
                uuid: this.participantUUID,
                name: this.name,
            },
            timestamp: new Date(),
        };

        recipients.forEach((recipient) => {
            // console.log('Sending message to recipient:', recipient, this.participantUUID);
            if (recipient === this.participantUUID) {
                // console.log('Skipping sending message to self:', recipient);
                return;
            }
            const dc = this.dcManager.getDataChannel(recipient);
            console.log('Data channel for recipient:', { recipient, dc });

            if (dc && dc.readyState === 'open') {
                console.log('Sending message over data channel:', { recipient, message });
                dc.send(JSON.stringify(message));
            } else {
                // try to restart or what?
                console.warn('Data channel not open for recipient:', { recipient, dc: dc });
            }
        });

        // Add your own message to the state
        this.dispatch({ type: 'ADD_MESSAGE', payload: message });
    }

    changeName(name: string): void {
        console.log('Changing name:', { oldName: this.name, newName: name });
        this.name = name;
        this.wsManager.changeName(name);
    }

    onDataChannelError(participantUUID: string): void {
        console.error(`Data channel error with participant ${participantUUID}`);
        this.dispatch({
            type: 'SET_ERROR',
            payload: { uuid: participantUUID, error: 'Data channel error' }
        });
        // restart peer connection or what?
        //     // Attempt to repair a broken data channel by recreating it
        // private repairDataChannel(participantUUID: string, pc: RTCPeerConnection | undefined): void {
        //     if (!pc) {
        //         console.error(`Cannot repair data channel: Peer connection not found for ${participantUUID}`);
        //         return;
        //     }
        //     if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        //         // If the connection is still valid, try to recreate the data channel
        //         const newDc = this.createDataChannel(participantUUID, pc);
        //         this.man.dispatch({
        //             type: 'UPDATE_PARTICIPANT_P2P_STATE',
        //             payload: { uuid: participantUUID, pc, dc: newDc }
        //         });
        //     } else {
        //         console.warn(`Cannot repair data channel: Peer connection is not stable for ${participantUUID}`);
        //     }
        // }
    }
}
