import RealtimeKitClient from '@cloudflare/realtimekit';
import { liveStreamStore, bindRtkEvents, type StreamType } from '$lib/stores/liveStreamStore';
import { browser } from '$app/environment';

export interface RtkInitOptions {
    authToken: string;
    streamType: StreamType;
    isHost: boolean;
    defaults?: Record<string, unknown>;
}

/**
 * Initializes a RealtimeKit meeting and connects it to the Svelte store.
 */
export async function initRtkMeeting(options: RtkInitOptions): Promise<{
    cleanup: () => Promise<void>;
    meeting: RealtimeKitClient | null;
    warning?: string;
}> {
    if (!browser) return { cleanup: async () => { }, meeting: null, warning: undefined };

    const { authToken, streamType, isHost, defaults } = options;
    let warning: string | undefined;
    let meeting: RealtimeKitClient | null = null;

    try {
        liveStreamStore.setConnectionStatus('initializing');

        try {
            meeting = await RealtimeKitClient.init({
                authToken,
                defaults: {
                    audio: false,
                    video: false,
                    ...defaults
                }
            });
        } catch (initError: unknown) {
            const err = initError as { message?: string; name?: string };
            if (isHost && (err.message?.includes('Permission denied') || err.name === 'NotAllowedError')) {
                console.warn('Media permissions denied, attempting fallback to no-media initialization');
                try {
                    meeting = await RealtimeKitClient.init({
                        authToken,
                        defaults: {
                            audio: false,
                            video: false
                        }
                    });
                    warning = 'Microphone or Camera permission denied. You joined without media. Please check browser settings.';
                } catch {
                    throw initError;
                }
            } else {
                throw initError;
            }
        }

        liveStreamStore.init(meeting, streamType, isHost);

        const unbindEvents = bindRtkEvents(meeting);

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

        meeting.self.on('roomJoined', () => {
            liveStreamStore.setConnectionStatus('connected');
        });

        meeting.self.on('mediaPermissionError', ({ kind }: { kind: string }) => {
            console.warn(`Permission denied for ${kind}`);
        });

        liveStreamStore.setConnectionStatus('idle');

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

    } catch (error: unknown) {
        console.error('Failed to initialize RealtimeKit meeting:', error);

        let errorMessage = 'Failed to connect to meeting';
        const err = error as { message?: string; name?: string };

        if (err.message?.includes('Permission denied') || err.name === 'NotAllowedError') {
            errorMessage = 'Microphone or Camera permission denied. Please allow access in your browser settings.';
        } else if (err.message?.includes('Network error') || err.message?.includes('fetch') || err.message?.includes('Failed to fetch')) {
            errorMessage = 'Network connection error. Please check your internet connection.';
        } else if (error instanceof Error) {
            errorMessage = error.message;
        }

        liveStreamStore.setError(errorMessage);
        liveStreamStore.setConnectionStatus('failed');
        throw error;
    }
}
