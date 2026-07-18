<script lang="ts">
    import { onMount, onDestroy } from 'svelte';

    export let analyser: AnalyserNode | null = null;
    export let dataArray: Uint8Array | null = null;

    let canvas: HTMLCanvasElement;
    let ctx: CanvasRenderingContext2D | null = null;
    let animationFrameId: number;
    let resizeObserver: ResizeObserver;
    let binMapping: number[] = [];
    let currentSampleRate: number = 0;

    const FFT_SIZE = 1024;
    const NUM_BARS = 128;
    const AMPLITUDE_NORMALIZER = 256.0;
    const MAX_BAR_WIDTH_RATIO = 0.8;
    const BASE_BAR_WIDTH = 2;
    const BAR_SPACING = 1;
    const MIN_FREQUENCY_HZ = 22.5;
    
    
    function mapAmplitudeToColor(amplitude: number): string {
        // Interpolating the hue value from blue (240) to red (0)
        const hue = 240 - (amplitude * 240);
        return `hsl(${hue}, 100%, 50%)`;
    }

    function calculateBinMapping(sampleRate: number) {
        if (sampleRate === currentSampleRate && binMapping.length === NUM_BARS) return;
        
        currentSampleRate = sampleRate;
        binMapping = new Array(NUM_BARS);
        
        const minHz = MIN_FREQUENCY_HZ;
        const maxHz = sampleRate / 2;
        const binSize = sampleRate / FFT_SIZE;

        for (let i = 0; i < NUM_BARS; i++) {
            const indexNormalized = i / NUM_BARS;
            // Using a logarithmic scale to allocate more bars to lower frequencies
            const exponent = (Math.log(maxHz / minHz) * indexNormalized);
            const freq = minHz * Math.exp(exponent);
            
            const bin = Math.floor(freq / binSize);
            binMapping[i] = Math.min(Math.max(bin, 0), (FFT_SIZE / 2) - 1);
        }
    }

    function draw() {
        if (!canvas || !ctx || !analyser) return;

        // Auto-initialize dataArray if needed
        if (!dataArray) {
            dataArray = new Uint8Array(analyser.frequencyBinCount);
        }

        // Get audio data
        if (dataArray) {
            analyser.getByteFrequencyData(dataArray as any);
        }
        
        const sampleRate = analyser.context.sampleRate;
        
        if (sampleRate !== currentSampleRate) {
            calculateBinMapping(sampleRate);
        }

        const width = canvas.width / (window.devicePixelRatio || 1);
        const height = canvas.height / (window.devicePixelRatio || 1);
        ctx.clearRect(0, 0, width, height);

        const barHeight = height / NUM_BARS;
        const centerX = width / 2;
        const maxBarWidth = width * MAX_BAR_WIDTH_RATIO;

        for (let i = 0; i < NUM_BARS; i++) {
            const binIndex = binMapping[i];
            const amplitude = dataArray[binIndex] || 0;
            const normalizedAmplitude = amplitude / AMPLITUDE_NORMALIZER;
            const barWidth = (normalizedAmplitude * maxBarWidth) + BASE_BAR_WIDTH;
            
            const color = mapAmplitudeToColor(normalizedAmplitude);
        
            const y = height - (i * barHeight) - barHeight;

            ctx.fillStyle = color;
            
            
            ctx.beginPath();
            // Draw a rounded rectangle or ellipse to look like a disc viewed from side
            // Simple rect for now as requested "bars"
            ctx.fillRect(centerX - (barWidth / 2), y, barWidth, barHeight - BAR_SPACING);
        }

        animationFrameId = requestAnimationFrame(draw);
    }

    function handleResize() {
        if (canvas && canvas.parentElement) {
            const parent = canvas.parentElement;
            const dpr = window.devicePixelRatio || 1;
            
            canvas.width = parent.clientWidth * dpr;
            canvas.height = parent.clientHeight * dpr;
            
            if (ctx) {
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.scale(dpr, dpr);
            }
        }
    }

    function requestFullScreen() {
        if (canvas && canvas.requestFullscreen) {
            canvas.requestFullscreen();
        }
    }

    onMount(() => {
        if (canvas) {
            ctx = canvas.getContext('2d');
            
            handleResize();

            resizeObserver = new ResizeObserver(handleResize);
            if (canvas.parentElement) {
                resizeObserver.observe(canvas.parentElement);
            }

            draw();
        }
    });

    onDestroy(() => {
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
        }
        if (resizeObserver) {
            resizeObserver.disconnect();
        }
    });
</script>

<canvas 
    bind:this={canvas}
    class="w-full h-full block cursor-pointer"
    style="background: transparent;"
    on:click={requestFullScreen}
></canvas>
