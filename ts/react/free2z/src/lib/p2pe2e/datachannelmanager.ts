import { Message } from "../webrtc-state";
import { WebRTCManager } from "./webrtcmanager";

export class DataChannelManager {
    private man: WebRTCManager;
    private dataChannels: Map<string, RTCDataChannel> = new Map();

    constructor(man: WebRTCManager) {
        this.man = man
    }

    private setupDataChannel(participantUUID: string, dc: RTCDataChannel): void {
        // Dispatch the 'open' state and update the participant's dataChannel
        dc.onopen = () => {
            this.man.dispatch({
                type: 'UPDATE_PARTICIPANT_DATA_CHANNEL',
                payload: { uuid: participantUUID, dc }
            });
        };

        // Handle incoming messages and dispatch them
        dc.onmessage = (e) => {
            console.log('Data channel message received:', e);
            try {
                const message: Message = JSON.parse(e.data);
                this.man.dispatch({ type: 'ADD_MESSAGE', payload: message });
            } catch (error) {
                console.error(`Failed to parse message from ${participantUUID}`, error);
            }
        };

        // Dispatch 'error' state and attempt to handle errors
        dc.onerror = (event) => {
            console.error(`Data channel error with participant ${participantUUID}:`, event);
            this.man.onDataChannelError(participantUUID);
        };

        // Dispatch 'close' state and update participant
        dc.onclose = () => {
            console.warn(`Data channel with participant ${participantUUID} closed.`);
            this.man.dispatch({
                type: 'UPDATE_PARTICIPANT_DATA_CHANNEL',
                payload: { uuid: participantUUID, dc: undefined }
            });
        };

        this.dataChannels.set(participantUUID, dc);
    }

    createDataChannel(participantUUID: string, pc: RTCPeerConnection): RTCDataChannel {
        const dc = pc.createDataChannel(`dataChannel-${participantUUID}`);
        this.setupDataChannel(participantUUID, dc);
        return dc;
    }

    handleReceivedDataChannel(participantUUID: string, dc: RTCDataChannel): void {
        this.setupDataChannel(participantUUID, dc);
    }

    // Retrieve the active data channel for a participant
    getDataChannel(participantId: string): RTCDataChannel | undefined {
        return this.dataChannels.get(participantId);
    }

    // Close all data channels cleanly
    closeDataChannels(): void {
        this.man.dispatch({
            type: "CLOSE_DATA_CHANNELS",
        });
        this.dataChannels.forEach((dc) => {
            console.log(`Closing data channel for participant`);
            dc.close();
        });
    }
}
