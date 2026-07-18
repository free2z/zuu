import { writable, derived } from 'svelte/store';
import type RealtimeKitClient from '@cloudflare/realtimekit';

export type RtkClient = RealtimeKitClient;
export type Participant = RealtimeKitClient['participants']['joined'] extends { toArray(): (infer P)[] } ? P : unknown;

export type ConnectionStatus = 'idle' | 'initializing' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'ended';
export type StreamType = 'broadcast' | 'subscribers-only' | 'ppv' | 'private';

export interface LiveStreamState {
    meeting: RtkClient | null;
    connectionStatus: ConnectionStatus;
    participants: Participant[];
    activeSpeakerId: string | null;
    audioLevels: Record<string, number>;
    streamType: StreamType | null;
    error: string | null;
    isHost: boolean;
    roomName: string | null;
    isOffline: boolean;
}

const initialState: LiveStreamState = {
    meeting: null,
    connectionStatus: 'idle',
    participants: [],
    activeSpeakerId: null,
    audioLevels: {},
    streamType: null,
    error: null,
    isHost: false,
    roomName: null,
    isOffline: false
};

function createLiveStreamStore() {
    const { subscribe, set, update } = writable<LiveStreamState>(initialState);

    return {
        subscribe,
        set,
        update,

        init: (client: RtkClient, type: StreamType, isHost: boolean) => {
            update(state => ({
                ...state,
                meeting: client,
                streamType: type,
                isHost,
                connectionStatus: 'initializing',
                roomName: client.meta?.meetingTitle || null
            }));
        },

        setConnectionStatus: (status: ConnectionStatus) => {
            update(state => ({ ...state, connectionStatus: status }));
        },

        setParticipants: (participants: Participant[]) => {
            update(state => ({ ...state, participants }));
        },

        updateAudioLevel: (participantId: string, level: number) => {
            update(state => ({
                ...state,
                audioLevels: {
                    ...state.audioLevels,
                    [participantId]: level
                }
            }));
        },

        setActiveSpeaker: (participantId: string | null) => {
            update(state => ({ ...state, activeSpeakerId: participantId }));
        },

        setError: (error: string) => {
            update(state => ({ ...state, error }));
        },

        setOffline: (isOffline: boolean) => {
            update(state => ({ ...state, isOffline }));
        },

        reset: () => {
            set(initialState);
        }
    };
}

export const liveStreamStore = createLiveStreamStore();

export const canJoinStream = derived(liveStreamStore, $state => {
    return $state.meeting !== null &&
        $state.error === null &&
        ($state.connectionStatus === 'initializing' || $state.connectionStatus === 'idle');
});

export const streamPermissions = derived(liveStreamStore, $state => {
    const isHost = $state.isHost;
    const isPrivate = $state.streamType === 'private';

    return {
        canPublishAudio: isHost || isPrivate,
        canPublishVideo: isHost || isPrivate,
        canScreenShare: isHost || isPrivate,
        canKickParticipants: isHost,
        canMuteParticipants: isHost,
        canEndMeeting: isHost
    };
});

export const participantCount = derived(liveStreamStore, $state => {
    return $state.participants.length;
});

export const isConnected = derived(liveStreamStore, $state => {
    return $state.connectionStatus === 'connected';
});

export const activeSpeaker = derived(liveStreamStore, $state => {
    if (!$state.activeSpeakerId) return null;
    return $state.participants.find(p => (p as { id?: string }).id === $state.activeSpeakerId) || null;
});

export function bindRtkEvents(client: RtkClient) {
    const updateParticipantsList = () => {
        const joined = client.participants.joined.toArray();
        liveStreamStore.setParticipants(joined);
    };

    const onActiveSpeaker = (payload: { peerId: string; volume: number }) => {
        liveStreamStore.setActiveSpeaker(payload.peerId);
        liveStreamStore.updateAudioLevel(payload.peerId, payload.volume);
    };

    client.participants.joined.on('participantJoined', updateParticipantsList);
    client.participants.joined.on('participantLeft', updateParticipantsList);
    client.participants.on('activeSpeaker', onActiveSpeaker);

    updateParticipantsList();

    return () => {
        client.participants.joined.off('participantJoined', updateParticipantsList);
        client.participants.joined.off('participantLeft', updateParticipantsList);
        client.participants.off('activeSpeaker', onActiveSpeaker);
    };
}
