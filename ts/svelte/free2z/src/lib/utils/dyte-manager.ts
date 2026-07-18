import DyteClient from '@dytesdk/web-core';
import { liveStreamStore, bindDyteEvents, type StreamType } from '$lib/stores/liveStreamStore';
import { browser } from '$app/environment';

export interface DyteInitOptions {
    authToken: string;
    streamType: StreamType;
    isHost: boolean;
    defaults?: any;
}

/**
 * Initializes a Dyte meeting and connects it to the Svelte store.
 * @param options Configuration options for the meeting
 * @returns A cleanup function to be called when the component is destroyed
 */
export async function initDyteMeeting(options: DyteInitOptions): Promise<{ cleanup: () => Promise<void>, meeting: any, warning?: string }> {
    if (!browser) return { cleanup: async () => { }, meeting: null, warning: undefined };

    const { authToken, streamType, isHost, defaults } = options;
    let warning: string | undefined;
    let meeting: any;

    try {
        liveStreamStore.setConnectionStatus('initializing');

        try {
            meeting = await DyteClient.init({
                authToken,
                defaults: {
                    audio: false,
                    video: false,
                    ...defaults
                }
            });
        } catch (initError: any) {
            // Handle permission errors with graceful degradation for hosts
            if (isHost && (initError.message?.includes('Permission denied') || initError.name === 'NotAllowedError')) {
                console.warn('Media permissions denied, attempting fallback to no-media initialization');
                try {
                    meeting = await DyteClient.init({
                        authToken,
                        defaults: {
                            audio: false,
                            video: false
                        }
                    });
                    warning = 'Microphone or Camera permission denied. You joined without media. Please check browser settings.';
                } catch (fallbackError) {
                    throw initError; // Throw original error if fallback fails
                }
            } else {
                throw initError;
            }
        }

        // Initialize the store with the meeting instance
        liveStreamStore.init(meeting, streamType, isHost);

        // Bind events
        const unbindEvents = bindDyteEvents(meeting);

        // Listen for room disconnection
        meeting.self.on('roomLeft', ({ state }: { state: string }) => {
            if (state === 'disconnected') {
                 liveStreamStore.setConnectionStatus('disconnected');
                 liveStreamStore.setError('Disconnected from the meeting.');
            } else if (state === 'failed') {
                 liveStreamStore.setConnectionStatus('failed');
                 liveStreamStore.setError('Connection to the meeting failed.');
            } else if (state === 'ended') {
                 liveStreamStore.setConnectionStatus('ended');
            }
        });

        // Listen for room join
        meeting.self.on('roomJoined', () => {
             liveStreamStore.setConnectionStatus('connected');
        });
        
        // Listen for media permission errors during the call
        meeting.self.on('mediaPermissionError', ({ kind }: { kind: string }) => {
            console.warn(`Permission denied for ${kind}`);
            // We could update the store here, but for now the initial warning covers the join case.
            // If it happens mid-stream (e.g. user revoked permission), Dyte usually handles the stream track ending.
        });

        // Set status to idle/ready (waiting for user to join via UI)
        liveStreamStore.setConnectionStatus('idle');

        // Return cleanup function and meeting instance
        return {
            cleanup: async () => {
                unbindEvents();
                if (meeting) {
                    await meeting.leaveRoom();
                }
                liveStreamStore.reset();
            },
            meeting,
            warning
        };

    } catch (error: any) {
        console.error('Failed to initialize Dyte meeting:', error);
        
        let errorMessage = 'Failed to connect to meeting';
        
        if (error.message?.includes('Permission denied') || error.name === 'NotAllowedError') {
            errorMessage = 'Microphone or Camera permission denied. Please allow access in your browser settings.';
        } else if (error.message?.includes('Network error') || error.message?.includes('fetch') || error.message?.includes('Failed to fetch')) {
            errorMessage = 'Network connection error. Please check your internet connection.';
        } else if (error instanceof Error) {
            errorMessage = error.message;
        }

        liveStreamStore.setError(errorMessage);
        liveStreamStore.setConnectionStatus('failed');
        throw error;
    }
}
