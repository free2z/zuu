import React, { useRef, useEffect, useState } from 'react';
import AudioVisualizerCanvas from './AudioVisualizerCanvas';
import { Stack, Button, Box } from '@mui/material';
import { Mic } from '@mui/icons-material';

const FFT_SIZE = 1024;

const AudioMicrophoneVisualizer: React.FC = () => {
    const audioContextRef = useRef<AudioContext | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const dataArrayRef = useRef<Uint8Array | null>(null);
    const [isListening, setIsListening] = useState(false);

    const handleAudioStream = (stream: MediaStream) => {
        if (!audioContextRef.current) {
            const audioContext = new AudioContext();
            audioContextRef.current = audioContext;

            const source = audioContext.createMediaStreamSource(stream);
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = FFT_SIZE;
            const bufferLength = analyser.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);

            analyserRef.current = analyser;
            dataArrayRef.current = dataArray;

            source.connect(analyser);
            // Note: Not connecting the analyser to the destination as we don't need to hear the input
        }
    };

    const startListening = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            handleAudioStream(stream);
            setIsListening(true);
        } catch (error) {
            console.error('Error accessing microphone:', error);
        }
    };

    useEffect(() => {
        // Clean up function to disconnect audio context and analyser
        return () => {
            if (audioContextRef.current) {
                audioContextRef.current.close();
            }
            if (analyserRef.current) {
                analyserRef.current.disconnect();
            }
        };
    }, []);

    return (
        <Box component="div" display="flex" justifyContent="center" alignItems="center">
            <Stack direction="column" alignItems="center"
                width={"100%"}
                height={"100vh"}
                position="relative" // Added for relative positioning
                sx={{
                    backgroundColor: 'black',
                }}
            >
                {isListening && (
                    <AudioVisualizerCanvas
                        dataArrayRef={dataArrayRef}
                        analyserRef={analyserRef}
                    />
                )}
                <Button
                    variant="contained"
                    onClick={startListening}
                    disabled={isListening}
                    sx={{
                        transform: 'translate(-50%, -50%)',
                        position: 'absolute',
                        top: '10%',
                        left: '10%',
                        zIndex: 1000000,
                    }}
                >
                    <Mic />
                </Button>
            </Stack>
        </Box>
    );
};

export default AudioMicrophoneVisualizer;
