import { Participant } from "../webrtc-state";
import { WebRTCManager } from "./webrtcmanager";

// Must match SIGNALING_SUBPROTOCOL in py/dj/apps/efm/consumers.py.
// The participant's JWT is presented during the WebSocket handshake as the
// second offered subprotocol; the server refuses the upgrade outright if it is
// missing or invalid, so nothing is ever sent over an unauthenticated socket.
// (Browsers cannot set headers on a WebSocket, and a query string would leak
// the bearer token into every proxy access log.)
export const SIGNALING_SUBPROTOCOL = 'frost-signaling-v1';

const RECONNECT_BASE_MS = 5000;
const RECONNECT_MAX_MS = 60000;

/**
 * Read the `exp` claim out of a JWT without verifying it.
 *
 * A browser cannot tell a rejected handshake from a network failure -- both
 * surface as close code 1006 -- so "the socket would not open" is NOT on its
 * own evidence that the credential is bad. Rather than guess after N failures
 * (which would turn any Daphne restart or network blip into a forced WebAuthn
 * ceremony), we look at the one thing the client can actually check locally:
 * whether the token it holds has expired. Signature and membership are still
 * the server's business; this only avoids reconnecting forever with a token
 * that is definitely dead.
 */
export function isTokenExpired(token: string): boolean {
    try {
        const payload = token.split('.')[1];
        if (!payload) {
            return true;
        }
        const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
        const exp = JSON.parse(json).exp;
        if (typeof exp !== 'number') {
            return false;
        }
        return exp * 1000 <= Date.now();
    } catch (e) {
        // Not a JWT we can read; let the server be the judge.
        return false;
    }
}

export type WebSocketMessage =
    | { type: 'join'; uuid: string; name: string }
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
    private reconnectAttempts = 0;
    private closedByUs = false;

    constructor(
        man: WebRTCManager,
    ) {
        this.man = man
    }

    initialize(): void {
        this.setupWebSocket();
    }

    close(): void {
        this.closedByUs = true;
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
        // The handshake succeeded, so the token was accepted.
        this.reconnectAttempts = 0;
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
        if (!this.man.token) {
            // The token is a required subprotocol; the WebSocket constructor
            // throws on an empty one, and the server would refuse it anyway.
            console.warn('No signaling token available; not connecting');
            this.man.dispatch({ type: 'SET_TOKEN', payload: '' });
            return;
        }
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const domain = window.location.hostname;
        const port = window.location.port ? `:${window.location.port}` : '';
        let wsUrl = `${wsProtocol}//${domain}${port}/ws/signaling/${this.man.UUID}/`;
        if (process.env.NODE_ENV === 'development') {
            wsUrl = `ws://localhost:8000/ws/signaling/${this.man.UUID}/`;
        }

        // The JWT is offered as a subprotocol so it is verified during the
        // handshake rather than in the first application message.
        this.ws = new WebSocket(wsUrl, [SIGNALING_SUBPROTOCOL, this.man.token]);

        this.ws.onopen = () => this.handleWebSocketOpen();

        this.ws.onmessage = (event) => {
            const data: WebSocketMessage = JSON.parse(event.data);
            this.handleWebSocketMessage(data);
        };

        this.ws.onclose = () => {
            this.man.dispatch({
                type: 'SET_WEBSOCKET_STATE', payload: {
                    uuid: this.man.participantUUID,
                    state: false,
                }
            });

            if (this.closedByUs) {
                return;
            }

            if (isTokenExpired(this.man.token)) {
                // The server will reject the handshake from here on, so
                // reconnecting is pointless. Drop the token and let the UI
                // take the participant back through WebAuthn.
                console.warn('Signaling token has expired; re-authentication required');
                this.man.dispatch({ type: 'SET_TOKEN', payload: '' });
                return;
            }

            // Anything else (server restart, network blip, rejected handshake
            // for a reason we cannot see) is retried with backoff. Never throw
            // away a still-valid credential over a transient failure.
            this.reconnectAttempts += 1;
            const delay = Math.min(
                RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1),
                RECONNECT_MAX_MS,
            );
            console.warn(`WebSocket connection closed. Reconnecting in ${delay}ms...`);
            setTimeout(() => this.setupWebSocket(), delay);
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
