<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { Mic, Square, Play, Pause, Download, Trash2, RefreshCcw } from '@lucide/svelte';
    import Button from '../ui/button/button.svelte';
    import AudioVisualizer from './AudioVisualizer.svelte';
    import { audioManager } from '$lib/utils/audio-manager';

    export let autoStart = false;

    let stream: MediaStream | null = null;
    let analyser: AnalyserNode | null = null;
    let mediaRecorder: MediaRecorder | null = null;
    let chunks: Blob[] = [];
    let recordingBlob: Blob | null = null;
    let recordingUrl: string | null = null;
    let audioElement: HTMLAudioElement | null = null;
    
    let isRecording = false;
    let isPlaying = false;
    let duration = 0;
    let timerInterval: NodeJS.Timeout;
    let currentTime = 0;

    onMount(async () => {
        if (autoStart) {
            await startMicrophone();
        }
    });

    onDestroy(() => {
        stopMicrophone();
        if (recordingUrl) {
            URL.revokeObjectURL(recordingUrl);
        }
    });

    async function startMicrophone() {
        try {
            await audioManager.resume();
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            
            // Track audio level for visualization using shared context
            analyser = audioManager.trackAudioLevel(stream, 'recorder-preview', 256);
            
        } catch (err) {
            console.error('Error accessing microphone:', err);
        }
    }

    function stopMicrophone() {
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
            stream = null;
        }
        
        audioManager.stopTracking('recorder-preview');
        analyser = null;
    }

    function startRecording() {
        if (!stream) return;
        
        chunks = [];
        mediaRecorder = new MediaRecorder(stream);
        
        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
                chunks.push(e.data);
            }
        };

        mediaRecorder.onstop = () => {
            recordingBlob = new Blob(chunks, { type: 'audio/webm' });
            recordingUrl = URL.createObjectURL(recordingBlob);
        };

        mediaRecorder.start();
        isRecording = true;
        duration = 0;
        timerInterval = setInterval(() => {
            duration++;
        }, 1000);
    }

    function stopRecording() {
        if (mediaRecorder && isRecording) {
            mediaRecorder.stop();
            isRecording = false;
            clearInterval(timerInterval);
        }
    }

    function togglePlayback() {
        if (!audioElement || !recordingUrl) return;

        if (isPlaying) {
            audioElement.pause();
        } else {
            audioElement.play();
        }
    }

    function handleEnded() {
        isPlaying = false;
        currentTime = 0;
    }

    function handleTimeUpdate() {
        if (audioElement) {
            currentTime = audioElement.currentTime;
        }
    }
    
    function deleteRecording() {
        recordingBlob = null;
        if (recordingUrl) URL.revokeObjectURL(recordingUrl);
        recordingUrl = null;
        duration = 0;
        currentTime = 0;
        isPlaying = false;
    }

    function formatTime(seconds: number) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
</script>

<div class=" p-4 flex flex-col gap-4 ">
    <div class="flex items-center justify-between">
        <h3 class="font-bold text-lg flex items-center gap-2">
            <Mic size={20} class="text-primary" />
            Voice Recorder
        </h3>
        {#if isRecording}
            <div class="flex items-center gap-2 text-red-500 animate-pulse bg-red-500/10 px-2 py-1 rounded-md">
                <div class="w-2 h-2 rounded-full bg-red-500"></div>
                <span class="font-mono text-sm font-bold">{formatTime(duration)}</span>
            </div>
        {/if}
    </div>

    <!-- Visualizer Area -->
    <div class="h-32 relative ">
        {#if stream && !recordingUrl && analyser}
             <AudioVisualizer {analyser} />
        {:else if recordingUrl}
             <AudioVisualizer {audioElement} />
             <!-- Hidden Audio Element -->
             <audio 
                bind:this={audioElement} 
                src={recordingUrl} 
                onplay={() => isPlaying = true}
                onpause={() => isPlaying = false}
                onended={handleEnded}
                ontimeupdate={handleTimeUpdate}
            ></audio>
        {:else}
            <div class="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground gap-2">
                <div class="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center">
                    <Mic size={20} />
                </div>
                <span class="text-sm">Microphone inactive</span>
            </div>
        {/if}
    </div>

    <!-- Controls -->
    <div class="flex items-center justify-between gap-4">
        <div class="flex items-center gap-2">
            {#if !recordingUrl}
                {#if !isRecording}
                    {#if !stream}
                         <Button variant="outline" size="sm" onclick={startMicrophone} class="gap-2">
                            Enable Mic
                        </Button>
                    {:else}
                        <Button variant="default" size="sm" class="bg-red-500 hover:bg-red-600 text-white gap-2" onclick={startRecording}>
                            <div class="w-2.5 h-2.5 rounded-full bg-white"></div> Record
                        </Button>
                        <Button variant="ghost" size="icon" onclick={stopMicrophone} title="Disable Mic">
                             <Trash2 size={16} class="text-muted-foreground" />
                        </Button>
                    {/if}
                {:else}
                    <Button variant="default" size="sm" class="bg-gray-700 hover:bg-gray-600 text-white gap-2" onclick={stopRecording}>
                        <Square size={16} fill="currentColor" /> Stop
                    </Button>
                {/if}
            {:else}
                <!-- Playback Controls -->
                 <Button variant="outline" size="icon" onclick={togglePlayback} class="rounded-full w-10 h-10">
                    {#if isPlaying}
                        <Pause size={18} fill="currentColor" />
                    {:else}
                        <Play size={18} fill="currentColor" class="ml-0.5" />
                    {/if}
                </Button>
                
                <div class="flex flex-col">
                    <span class="text-xs text-muted-foreground">Playback</span>
                    <div class="text-sm font-mono font-medium">
                        {formatTime(currentTime)} / {formatTime(duration)}
                    </div>
                </div>
            {/if}
        </div>

        <div class="flex items-center gap-2">
             {#if recordingUrl}
                <a href={recordingUrl} download={`recording-${new Date().toISOString()}.webm`}>
                    <Button variant="outline" size="sm" class="gap-2">
                        <Download size={16} /> Save
                    </Button>
                </a>
                <Button variant="ghost" size="icon" class="text-destructive hover:bg-destructive/10" onclick={deleteRecording} title="Delete Recording">
                    <Trash2 size={18} />
                </Button>
             {/if}
        </div>
    </div>
</div>
