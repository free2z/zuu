import { Participant } from "../webrtc-state";
import { WebRTCManager } from "./webrtcmanager";

export type WebSocketMessage =
    | { type: 'join'; uuid: string; name: string; token: string }
    | { type: 'change_name'; uuid: string; name: string }
    | { type: 'update_participants'; participants: Record<string, Participant> }
    | { type: 'name_changed'; uuid: string; name: string }
    | { type: 'offer'; target: string; source: string; sdp: string }
    | { type: 'answer'; target: string; source: string; sdp: string }
    | { type: 'ice_candidate'; target: string; source: string; candidate: RTCIceCandidateInit }
    | { type: 'error' };

export class WebSocketManager {
    private participants: Record<string, Participant> = {};
    private man: WebRTCManager;
    private ws: WebSocket | null = null;

    constructor(
        man: WebRTCManager,
    ) {
        this.man = man
    }

    initialize(): void {
        this.setupWebSocket();
    }

    close(): void {
        this.ws?.close();
        this.man.dispatch({
            type: 'SET_WEBSOCKET_STATE',
            payload: {
                uuid: this.man.UUID,
                state: false,
            },
        });
    }

    changeName(newName: string): void {
        this.man.dispatch({ type: 'SET_NAME', payload: newName });
        localStorage.setItem(`session-${this.man.UUID}-name`, newName);
        this.sendMessage({
            type: 'change_name',
            uuid: this.man.participantUUID,
            name: newName,
        });
    }

    sendMessage(message: WebSocketMessage): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        } else {
            console.warn('WebSocket is not open. Message not sent:', message);
        }
    }

    private handleWebSocketOpen(): void {
        console.log('WebSocket connection opened');
        this.man.dispatch({
            type: 'SET_WEBSOCKET_STATE',
            payload: {
                uuid: this.man.participantUUID,
                state: true,
            }
        });

        this.sendMessage({
            type: 'join',
            uuid: this.man.participantUUID,
            name: this.man.name,
            token: this.man.token,
        });
    }

    private handleWebSocketMessage(data: WebSocketMessage): void {
        console.log('Handling WebSocket message:', data);
        switch (data.type) {
            case 'update_participants':
                this.updateParticipants(data.participants);
                break;
            case 'name_changed':
                this.handleNameChange(data.uuid, data.name);
                break;
            case 'offer':
            case 'answer':
            case 'ice_candidate':
                this.man.handleSignalingMessage(data);
                break;
            case 'error':
                console.warn('Received error message from server', data);
                this.man.dispatch({ type: 'SET_TOKEN', payload: '' });
                break;
            default:
                console.warn('Unhandled message type:', data.type);
        }
    }

    private updateParticipants(participants: Record<string, Participant>): void {
        this.participants = participants;
        console.log('Updating participants:', participants);
        this.man.dispatch({
            type: 'SET_SERVER_PARTICIPANTS',
            payload: participants,
        });
        this.man.reconcilePeerConnections(participants);
    }

    private handleNameChange(uuid: string, name: string): void {
        const participant = this.participants[uuid];
        if (participant) {
            participant.name = name || participant.uuid;
            this.man.dispatch({
                type: 'SET_PARTICIPANT_NAME',
                payload: { uuid, name }
            });
        }
    }

    private setupWebSocket(): void {
        console.log('Setting up WebSocket connection');
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const domain = window.location.hostname;
        const port = window.location.port ? `:${window.location.port}` : '';
        let wsUrl = `${wsProtocol}//${domain}${port}/ws/signaling/${this.man.UUID}/`;
        if (process.env.NODE_ENV === 'development') {
            wsUrl = `ws://localhost:8000/ws/signaling/${this.man.UUID}/`;
        }

        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => this.handleWebSocketOpen();

        this.ws.onmessage = (event) => {
            const data: WebSocketMessage = JSON.parse(event.data);
            this.handleWebSocketMessage(data);
        };

        this.ws.onclose = () => {
            console.warn('WebSocket connection closed. Attempting to reconnect...');
            this.man.dispatch({
                type: 'SET_WEBSOCKET_STATE', payload: {
                    uuid: this.man.participantUUID,
                    state: false,
                }
            });
            setTimeout(() => this.setupWebSocket(), 5000);
        };

        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            this.man.dispatch({
                type: 'SET_WEBSOCKET_STATE', payload: {
                    uuid: this.man.participantUUID,
                    state: false,
                }
            });
        };
    }
}
