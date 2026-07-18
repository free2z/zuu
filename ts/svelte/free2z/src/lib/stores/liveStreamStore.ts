import { writable, derived } from 'svelte/store';
import type DyteClient from '@dytesdk/web-core';
import type { DyteParticipant } from '@dytesdk/web-core';

// Re-export for convenience
export type { DyteClient };

export type Participant = DyteParticipant;

export type ConnectionStatus = 'idle' | 'initializing' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'ended';
export type StreamType = 'broadcast' | 'subscribers-only' | 'ppv' | 'private';

export interface LiveStreamState {
    meeting: DyteClient | null;
    connectionStatus: ConnectionStatus;
    participants: Participant[];
    activeSpeakerId: string | null;
    audioLevels: Record<string, number>; // participantId -> level (0-1)
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

        /**
         * Initialize the store with a Dyte client instance and stream configuration
         */
        init: (client: DyteClient, type: StreamType, isHost: boolean) => {
            update(state => ({
                ...state,
                meeting: client,
                streamType: type,
                isHost,
                connectionStatus: 'initializing',
                roomName: client.meta?.meetingTitle || null
            }));
        },

        /**
         * Update connection status
         */
        setConnectionStatus: (status: ConnectionStatus) => {
            update(state => ({ ...state, connectionStatus: status }));
        },

        /**
         * Update the list of active participants
         */
        setParticipants: (participants: Participant[]) => {
            update(state => ({ ...state, participants }));
        },

        /**
         * Update audio level for a specific participant
         * Useful for visualizers
         */
        updateAudioLevel: (participantId: string, level: number) => {
            update(state => ({
                ...state,
                audioLevels: {
                    ...state.audioLevels,
                    [participantId]: level
                }
            }));
        },

        /**
         * Set the active speaker
         */
        setActiveSpeaker: (participantId: string | null) => {
            update(state => ({ ...state, activeSpeakerId: participantId }));
        },

        /**
         * Handle errors
         */
        setError: (error: string) => {
            update(state => ({ ...state, error }));
        },

        /**
         * Set offline status
         */
        setOffline: (isOffline: boolean) => {
            update(state => ({ ...state, isOffline }));
        },

        /**
         * Reset the store to initial state
         * Should be called when leaving the stream/component unmounts
         */
        reset: () => {
            set(initialState);
        }
    };
}

export const liveStreamStore = createLiveStreamStore();

// --- Derived Stores ---

/**
 * Check if the user can join the stream based on current state
 */
export const canJoinStream = derived(liveStreamStore, $state => {
    return $state.meeting !== null &&
        $state.error === null &&
        ($state.connectionStatus === 'initializing' || $state.connectionStatus === 'idle');
});

/**
 * Permissions for the current user based on their role (Host vs Viewer)
 */
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

/**
 * Count of current participants
 */
export const participantCount = derived(liveStreamStore, $state => {
    return $state.participants.length;
});

/**
 * Boolean indicating if the client is fully connected to the meeting
 */
export const isConnected = derived(liveStreamStore, $state => {
    return $state.connectionStatus === 'connected';
});

/**
 * Get the current active speaker object
 */
export const activeSpeaker = derived(liveStreamStore, $state => {
    if (!$state.activeSpeakerId) return null;
    return $state.participants.find(p => p.id === $state.activeSpeakerId) || null;
});

/**
 * Helper to bind Dyte client events to the store
 * This should be called after initializing the meeting
 */
export function bindDyteEvents(client: DyteClient) {
    // Update participants when they join/leave
    const updateParticipantsList = () => {
        // Use client.participants.joined to retrieve all participants currently in the meeting.
        // client.participants.active is also available but typically used for paginated grids.
        const joined = client.participants.joined.toArray();
        liveStreamStore.setParticipants(joined);
    };

    const onActiveSpeaker = (payload: { peerId: string; volume: number }) => {
        liveStreamStore.setActiveSpeaker(payload.peerId);
        // Update audio level for the speaker
        liveStreamStore.updateAudioLevel(payload.peerId, payload.volume);
    };

    // Subscribe to participant events based on Dyte SDK documentation
    client.participants.joined.on('participantJoined', updateParticipantsList);
    client.participants.joined.on('participantLeft', updateParticipantsList);
    client.participants.on('activeSpeaker', onActiveSpeaker);

    // Initial population
    updateParticipantsList();

    return () => {
        // Cleanup function to remove listeners
        client.participants.joined.off('participantJoined', updateParticipantsList);
        client.participants.joined.off('participantLeft', updateParticipantsList);
        client.participants.off('activeSpeaker', onActiveSpeaker);
    };
}
