import { browser } from '$app/environment';
import { liveStreamStore } from '$lib/stores/liveStreamStore';

const AUDIO_LEVEL_UPDATE_INTERVAL_MS = 100;
const AUDIO_NORMALIZATION_THRESHOLD = 128; // Used to normalize 0-255 byte values to a 0-1 range.
// 128 (half of 256) is chosen to increase sensitivity for typical audio levels.
const SPEAKING_THRESHOLD = 0.1; // Threshold for normalized audio level to be considered "speaking"

// Type definition for WebKit prefixed AudioContext
declare global {
    interface Window {
        webkitAudioContext: typeof AudioContext;
    }
}

interface AudioResource {
    source: MediaStreamAudioSourceNode;
    analyser: AnalyserNode;
    interval: number;
}

class AudioManager {
    private context: AudioContext | null = null;
    private resources: Map<string, AudioResource> = new Map();
    private isInitialized = false;

    constructor() {
        if (browser) {
            this.setupLifecycleListeners();
        }
    }

    /**
     * Set up global lifecycle listeners for cleanup and state management
     */
    private setupLifecycleListeners() {
        if (this.isInitialized) return;

        // Clean up on page unload
        window.addEventListener('beforeunload', () => {
            this.cleanup();
        });

        // Handle visibility change to suspend/resume if needed
        // While modern browsers handle AudioContext suspension automatically in some cases,
        // explicit handling ensures we don't hold resources unnecessarily.
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                 // Optionally suspend, but usually better to keep running if background audio is desired.
                 // If the requirement is strictly "proper cleanup/handling", we can just ensure
                 // we resume when visible if it got suspended.
                 if (this.context && this.context.state === 'running') {
                     // We could suspend here if we wanted to enforce no background audio processing
                 }
            } else {
                this.resume().catch(console.warn);
            }
        });

        // Auto-resume on user interaction if suspended (browser policy)
        const handleInteraction = () => {
            if (this.context && this.context.state === 'suspended') {
                this.resume().catch(err => {
                    // Suppress harmless warnings if resume is called while already resuming
                    console.debug('Auto-resume failed:', err);
                });
            }
        };

        // Capture common interaction events
        ['click', 'keydown', 'touchstart', 'mousedown'].forEach(event => {
            window.addEventListener(event, handleInteraction, { passive: true, capture: true });
        });

        this.isInitialized = true;
    }

    /**
     * Get or create the shared AudioContext
     */
    getContext(): AudioContext | null {
        if (!browser) {
            return null; // Gracefully handle SSR
        }

        if (!this.context) {
            try {
                const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                if (!AudioContextClass) {
                    throw new Error('Web Audio API is not supported in this browser');
                }
                this.context = new AudioContextClass();
                
                // Monitor state changes
                this.context.onstatechange = () => {
                    // Could dispatch state changes to store if needed
                };

            } catch (error) {
                console.error('Failed to create AudioContext:', error);
                liveStreamStore.setError(`Audio initialization failed: ${(error as Error).message}`);
                return null;
            }
        }

        // Try to resume if suspended (common in browsers requiring user interaction)
        if (this.context.state === 'suspended') {
            this.context.resume().catch(() => {
                // Ignore initial resume failure, will rely on user interaction
            });
        }

        return this.context;
    }

    /**
     * Create an analyser node for a media stream and track audio levels
     * @param stream The MediaStream to analyze
     * @param participantId The ID of the participant (or 'local' for self)
     * @param fftSize FFT size for the analyser (default 1024)
     * @returns The AnalyserNode or null if creation failed
     */
    trackAudioLevel(stream: MediaStream, participantId: string, fftSize: number = 1024): AnalyserNode | null {
        const ctx = this.getContext();
        if (!ctx) return null;

        try {
            // Clean up existing tracker for this participant if any
            this.stopTracking(participantId);

            // Verify stream is active and has audio tracks
            if (!stream.active || stream.getAudioTracks().length === 0) {
                console.warn(`Stream for participant ${participantId} has no active audio tracks`);
                return null;
            }

            const source = ctx.createMediaStreamSource(stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = fftSize;
            // smoothingTimeConstant can be adjusted for visual preference
            analyser.smoothingTimeConstant = 0.8; 

            source.connect(analyser);

            const dataArray = new Uint8Array(analyser.frequencyBinCount);

            // Set up polling for audio levels
            const interval = window.setInterval(() => {
                if (analyser && ctx.state === 'running') {
                    analyser.getByteFrequencyData(dataArray);

                    // Calculate average volume
                    let sum = 0;
                    for (let i = 0; i < dataArray.length; i++) {
                        sum += dataArray[i];
                    }
                    const average = sum / dataArray.length;
                    const normalizedLevel = Math.min(1, average / AUDIO_NORMALIZATION_THRESHOLD);

                    // Update store
                    liveStreamStore.updateAudioLevel(participantId, normalizedLevel);

                    // Simple active speaker detection logic (local heuristic)
                     if (normalizedLevel > SPEAKING_THRESHOLD) {
                        // liveStreamStore.setActiveSpeaker(participantId);
                    }
                }
            }, AUDIO_LEVEL_UPDATE_INTERVAL_MS);

            this.resources.set(participantId, {
                source,
                analyser,
                interval
            });

            return analyser;
        } catch (error) {
            console.error(`Failed to track audio for ${participantId}:`, error);
            liveStreamStore.setError(`Audio tracking failed: ${(error as Error).message}`);
            return null;
        }
    }

    /**
     * Stop tracking audio levels for a participant and clean up nodes
     */
    stopTracking(participantId: string) {
        const resource = this.resources.get(participantId);
        if (resource) {
            window.clearInterval(resource.interval);
            try {
                // Disconnect to release resources
                resource.source.disconnect();
                resource.analyser.disconnect();
            } catch (e) {
                // Ignore disconnect errors (e.g. if context is already closed)
            }
            this.resources.delete(participantId);
            
            // Clean up store state
            liveStreamStore.updateAudioLevel(participantId, 0);
        }
    }

    /**
     * Resume AudioContext if suspended
     * Should be called from a user interaction event handler
     */
    async resume() {
        if (this.context && this.context.state === 'suspended') {
            try {
                await this.context.resume();
            } catch (error) {
                console.warn('Failed to resume AudioContext:', error);
            }
        }
    }

    /**
     * Clean up all audio resources
     */
    cleanup() {
        this.resources.forEach((_, id) => this.stopTracking(id));
        this.resources.clear();
        
        if (this.context) {
            this.context.close().catch(console.error);
            this.context = null;
        }
    }
}

export const audioManager = new AudioManager();
