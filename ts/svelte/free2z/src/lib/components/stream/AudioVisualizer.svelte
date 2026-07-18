<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { liveStreamStore } from '$lib/stores/liveStreamStore';

    // Props for flexibility and React-like ref compatibility
    export let analyser: AnalyserNode | null = null;
    export let dataArray: Uint8Array | null = null; // Optional: allow passing shared buffer
    
    // Convenience props for self-managed mode
    export let stream: MediaStream | null = null;
    export let audioElement: HTMLAudioElement | null = null;
    
    // Prop for store-based visualization
    export let participantId: string | null = null;

    let canvas: HTMLCanvasElement;
    let audioContext: AudioContext | null = null;
    let internalAnalyser: AnalyserNode | null = null;
    let source: MediaStreamAudioSourceNode | MediaElementAudioSourceNode | null = null;
    let animationId: number;
    let resizeObserver: ResizeObserver;
    
    let currentLevel = 0;

    // Reactive update for store-based level
    $: if (participantId) {
        currentLevel = $liveStreamStore.audioLevels[participantId] || 0;
    }

    // Determine which analyser to use
    $: activeAnalyser = analyser || internalAnalyser;

    // Reactive setup for internal context if external analyser is not provided
    $: if (!analyser && !participantId && (stream || audioElement)) {
        setupInternalContext();
    } else if (analyser && internalAnalyser) {
        // If external analyser is provided later, cleanup internal one
        cleanupInternal();
    }

    // Start visualizing when we have an analyser OR participantId, and canvas
    $: if ((activeAnalyser || participantId) && canvas) {
        visualize();
    }

    // Cleanup on stream/element/participant removal
    $: if (!analyser && !stream && !audioElement && !participantId) {
        cleanupInternal();
        if (animationId) cancelAnimationFrame(animationId);
    }

    onMount(() => {
        resizeObserver = new ResizeObserver(() => {
            if (canvas) {
                // Handle high DPI displays
                const dpr = window.devicePixelRatio || 1;
                const rect = canvas.getBoundingClientRect();
                
                canvas.width = rect.width * dpr;
                canvas.height = rect.height * dpr;
                
                // Scale context to match
                const ctx = canvas.getContext('2d');
                if (ctx) ctx.scale(dpr, dpr);
            }
        });
        if (canvas) resizeObserver.observe(canvas);
        
        return () => {
             cleanupInternal();
             if (animationId) cancelAnimationFrame(animationId);
             if (resizeObserver) resizeObserver.disconnect();
        };
    });
    
    onDestroy(() => {
        cleanupInternal();
        if (animationId) cancelAnimationFrame(animationId);
    });

    function cleanupInternal() {
        if (source) {
            source.disconnect();
            source = null;
        }
        if (internalAnalyser) {
            internalAnalyser.disconnect();
            internalAnalyser = null;
        }
        // We generally don't close the AudioContext if it might be shared, 
        // but if we created it locally for this component, we can close it.
        // For safety in this hybrid mode, we'll only close if we created it.
        if (audioContext && audioContext.state !== 'closed') {
            audioContext.close().catch(() => {});
            audioContext = null;
        }
    }

    async function setupInternalContext() {
        // Don't setup if we already have one for the current inputs
        if (internalAnalyser && audioContext?.state === 'running') return;
        
        // Don't setup internal context if we are using store based visualization
        if (participantId) return;

        cleanupInternal();

        try {
            audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
            internalAnalyser = audioContext.createAnalyser();
            internalAnalyser.fftSize = 256;
            // Smoothing for nicer visuals
            internalAnalyser.smoothingTimeConstant = 0.8; 

            if (stream && stream.active) {
                source = audioContext.createMediaStreamSource(stream);
                source.connect(internalAnalyser);
            } else if (audioElement) {
                 try {
                    // Note: This requires CORS if audio is from another domain
                    source = audioContext.createMediaElementSource(audioElement);
                    source.connect(internalAnalyser);
                    internalAnalyser.connect(audioContext.destination);
                 } catch (e) {
                     console.error("Error creating element source", e);
                     return;
                 }
            }
            
            // Trigger visualization
            activeAnalyser = internalAnalyser;
            visualize();
        } catch (err) {
            console.error('Error setting up audio context:', err);
        }
    }

    function visualize() {
        if (!canvas || (!activeAnalyser && !participantId)) return;
        
        // Cancel existing loop to avoid duplicates
        if (animationId) cancelAnimationFrame(animationId);

        // If simulating, use a fixed buffer length
        const bufferLength = activeAnalyser ? activeAnalyser.frequencyBinCount : 32;
        // Use provided dataArray or create new one
        const data = dataArray || new Uint8Array(bufferLength);
        
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const draw = () => {
            animationId = requestAnimationFrame(draw);

            if (activeAnalyser) {
                activeAnalyser.getByteFrequencyData(data as any);
            } else if (participantId) {
                // Simulate frequency data from scalar volume level (0-1)
                // We create a visualization that looks somewhat like a spectrum
                // Center weighted with random noise for aliveness
                const baseVol = currentLevel * 255;
                
                // Falloff if no audio to prevent static noise
                if (baseVol < 1) {
                     data.fill(0);
                } else {
                    for (let i = 0; i < bufferLength; i++) {
                        // Create a symmetric mountain shape
                        const distanceFromCenter = Math.abs(i - bufferLength / 2) / (bufferLength / 2);
                        const shapeFactor = 1 - distanceFromCenter; // 1 at center, 0 at edges
                        
                        // Add noise relative to volume
                        const noise = Math.random() * (baseVol * 0.2);
                        
                        // Calculate bar height
                        let val = (baseVol * shapeFactor) + noise;
                        
                        data[i] = Math.max(0, Math.min(255, val));
                    }
                }
            }

            // Clear canvas
            // Use getBoundingClientRect for correct clearing dimensions in logic
            const width = canvas.width / (window.devicePixelRatio || 1);
            const height = canvas.height / (window.devicePixelRatio || 1);
            
            ctx.clearRect(0, 0, width, height);

            const barWidth = (width / bufferLength) * 2.5;
            let barHeight;
            let x = 0;

            for (let i = 0; i < bufferLength; i++) {
                barHeight = (data[i] / 255) * height; // Scale to canvas height

                // HSL Spectrum Color
                // Map frequency index to Hue (0-360)
                // We can limit range to visible spectrum or go full rainbow
                const hue = (i / bufferLength) * 360; 
                const saturation = 100;
                const lightness = 50;
                
                ctx.fillStyle = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
                
                // Draw bar
                ctx.fillRect(x, height - barHeight, barWidth, barHeight);

                x += barWidth + 1;
            }
        };

        draw();
    }
</script>

<canvas 
    bind:this={canvas} 
    class="w-full h-full min-h-[100px] rounded-lg bg-black/90 shadow-inner"
></canvas>
