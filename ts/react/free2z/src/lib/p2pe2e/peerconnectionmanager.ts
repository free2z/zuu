import { WebSocketMessage } from "./websocketmanager";
import { WebRTCManager } from "./webrtcmanager";

export class PeerConnectionManager {
    private man: WebRTCManager;
    private peerConnections: Map<string, RTCPeerConnection> = new Map();
    private configuration: RTCConfiguration;
    private candidateQueue: Map<string, RTCIceCandidateInit[]> = new Map();

    constructor(
        man: WebRTCManager,
    ) {
        this.man = man;
        this.configuration = {
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
            iceTransportPolicy: 'all',
            iceCandidatePoolSize: 20,
        };
    }

    createPeerConnection(participantUUID: string): RTCPeerConnection {
        console.log('Creating peer connection with:', participantUUID);
        const pc = new RTCPeerConnection(this.configuration);

        // Attach event handlers for ICE connection state changes and ICE candidates
        pc.oniceconnectionstatechange = () => {
            console.log(`ICE connection state for ${participantUUID}: ${pc.iceConnectionState}`);
            const dc = this.man.dcManager.getDataChannel(participantUUID);
            this.handleICEConnectionStateChange(participantUUID, pc, dc);
        };

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                console.log('Sending ICE candidate:', event.candidate);
                this.man.wsManager.sendMessage({
                    type: 'ice_candidate',
                    target: participantUUID,
                    source: this.man.participantUUID,
                    candidate: event.candidate.toJSON(),
                });
            }
        };

        this.peerConnections.set(participantUUID, pc);

        // Initiate data channel creation based on participant UUIDs
        if (this.man.participantUUID < participantUUID) {
            this.man.dcManager.createDataChannel(participantUUID, pc);
            this.createOffer(participantUUID, pc);
        } else {
            pc.ondatachannel = (event) => {
                console.log('Data channel received:', event.channel.label);
                this.man.dcManager.handleReceivedDataChannel(participantUUID, event.channel);
            };
        }
        return pc;
    }

    updatePeerConnection(participantUUID: string): void {
        const pc = this.getPeerConnection(participantUUID);
        console.log(`Updating peer connection with participant ${participantUUID}:`, pc);
        if (!pc || pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
            console.warn(`Re-establishing peer connection with participant ${participantUUID}`);
            this.closeConnection(participantUUID);
            this.createPeerConnection(participantUUID);
        }
    }

    getActiveConnections(): Record<string, RTCPeerConnection> {
        const activeConnections: Record<string, RTCPeerConnection> = {};
        this.peerConnections.forEach((pc, uuid) => {
            if (pc.iceConnectionState !== 'closed' && pc.iceConnectionState !== 'failed') {
                activeConnections[uuid] = pc;
            }
        });
        return activeConnections;
    }

    closeConnection(participantUUID: string): void {
        const pc = this.peerConnections.get(participantUUID);
        if (pc) {
            console.log(`Closing connection with participant ${participantUUID}`);
            pc.close();
            this.peerConnections.delete(participantUUID);
            this.man.dispatch({
                type: 'REMOVE_ERROR',
                payload: { uuid: participantUUID },
            });
        }
        this.man.dispatch({
            type: 'UPDATE_PARTICIPANT_PEER_CONNECTION',
            payload: { uuid: participantUUID, pc: undefined },
        });
    }

    private getPeerConnection(participantUUID: string): RTCPeerConnection | undefined {
        return this.peerConnections.get(participantUUID);
    }

    private async createOffer(participantUUID: string, pc: RTCPeerConnection): Promise<void> {
        try {
            console.log(`Creating offer for ${participantUUID}`);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            this.man.wsManager.sendMessage({
                type: 'offer',
                target: participantUUID,
                source: this.man.participantUUID,
                sdp: offer.sdp ?? '',
            });
        } catch (error) {
            console.error(`Error creating offer for ${participantUUID}:`, error);
            this.dispatchError(participantUUID, 'Error creating offer');
        }
    }

    private async handleOffer(data: WebSocketMessage): Promise<void> {
        if (data.type !== 'offer') return;

        const pc = this.getPeerConnection(data.source);
        if (!pc || pc.signalingState === 'closed') return;

        try {
            console.log(`Setting remote description for ${data.source}`);
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.sdp }));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this.man.wsManager.sendMessage({
                type: 'answer',
                target: data.source,
                source: this.man.participantUUID,
                sdp: answer.sdp ?? '',
            });
        } catch (error) {
            console.error(`Error handling offer for ${data.source}:`, error);
            this.dispatchError(data.source, 'Error handling offer');
        }
    }

    private async handleAnswer(data: WebSocketMessage): Promise<void> {
        if (data.type !== 'answer') return;

        const pc = this.getPeerConnection(data.source);
        if (!pc || pc.signalingState === 'closed') return;

        try {
            console.log(`Setting remote description for ${data.source}`);
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.sdp }));
            this.man.dispatch({
                type: 'REMOVE_ERROR',
                payload: { uuid: data.source },
            });
        } catch (error) {
            console.error(`Error handling answer for ${data.source}:`, error);
            this.dispatchError(data.source, 'Error handling answer');
        }
    }

    async handleICECandidate(data: WebSocketMessage): Promise<void> {
        if (data.type !== 'ice_candidate') return;
        const pc = this.getPeerConnection(data.source);
        if (!pc || pc.signalingState === 'closed') {
            console.warn(`Cannot add ICE candidate, peer connection is closed or missing for ${data.source}`);
            return;
        }

        // Queue the ICE candidate if the remote description isn't set yet
        if (!pc.remoteDescription || !pc.remoteDescription.sdp) {
            console.warn(`Remote description not set yet for ${data.source}, queuing candidate`);
            const queue = this.candidateQueue.get(data.source) || [];
            queue.push(data.candidate);
            this.candidateQueue.set(data.source, queue);
            return;
        }

        try {
            console.log(`Adding ICE candidate for ${data.source}:`, data.candidate);
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate));

            // Once the description is set, drain the queue
            if (this.candidateQueue.has(data.source)) {
                const queuedCandidates = this.candidateQueue.get(data.source) || [];
                for (const candidate of queuedCandidates) {
                    await pc.addIceCandidate(new RTCIceCandidate(candidate));
                }
                this.candidateQueue.delete(data.source);
            }
        } catch (error) {
            console.error(`Error adding ICE candidate for ${data.source}:`, error);
            this.dispatchError(data.source, 'Error adding ICE candidate');
        }
    }
    private handleICEConnectionStateChange(participantUUID: string, pc: RTCPeerConnection, dc?: RTCDataChannel): void {
        const state = pc.iceConnectionState;
        console.log(`ICE connection state changed for ${participantUUID}: ${state}`);

        this.man.dispatch({
            type: 'UPDATE_PARTICIPANT_P2P_STATE',
            payload: {
                uuid: participantUUID,
                pc,
                dc,
            },
        });

        if (state === 'disconnected' || state === 'failed') {
            console.warn(`Connection with participant ${participantUUID} is ${state}. Attempting to reconnect...`);
            this.dispatchError(participantUUID, `Connection ${state}`);
            this.retryConnection(participantUUID);
        } else if (state === 'closed') {
            console.log(`Connection with participant ${participantUUID} closed.`);
            this.closeConnection(participantUUID);
        } else if (state === 'connected' || state === 'completed') {
            console.log(`Connection with participant ${participantUUID} is ${state}.`);
            this.man.dispatch({
                type: 'REMOVE_ERROR',
                payload: { uuid: participantUUID },
            });
        }
    }

    private retryConnection(participantUUID: string): void {
        const existingPC = this.getPeerConnection(participantUUID);
        if (existingPC) {
            existingPC.close();
        }
        setTimeout(() => this.createPeerConnection(participantUUID), 1000); // 1 second delay for retry
    }

    private dispatchError(participantUUID: string, errorMessage: string): void {
        console.error(`Error with participant ${participantUUID}: ${errorMessage}`);
        this.man.dispatch({
            type: 'SET_ERROR',
            payload: {
                uuid: participantUUID,
                error: errorMessage,
            },
        });
    }

    handleSignalingMessage(data: WebSocketMessage): void {
        switch (data.type) {
            case 'offer':
                this.handleOffer(data);
                break;
            case 'answer':
                this.handleAnswer(data);
                break;
            case 'ice_candidate':
                this.handleICECandidate(data);
                break;
            default:
                console.warn(`Unhandled signaling message type: ${data.type}`);
        }
    }
}
