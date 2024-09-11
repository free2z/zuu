import React, { useRef, useEffect, useState } from 'react';
import { Box, Stack } from '@mui/material';

import AudioVisualizerCanvas from './AudioVisualizerCanvas';

const FFT_SIZE = 1024
const CANVAS_HEIGHT = 150;

type AudioVisualizerProps = {
    src: string
}

const AudioVisualizer: React.FC<AudioVisualizerProps> = ({ src }) => {
    const audioRef = useRef<HTMLAudioElement>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const dataArrayRef = useRef<Uint8Array | null>(null);
    const [isAudioPlaying, setIsAudioPlaying] = useState(false);

    const handleAudioPlay = async () => {
        if (!audioContextRef.current && audioRef.current) {
            try {
                const audioContext = new AudioContext();
                audioContextRef.current = audioContext;

                const track = audioContext.createMediaElementSource(audioRef.current);
                const analyser = audioContext.createAnalyser();
                analyser.fftSize = FFT_SIZE;
                const bufferLength = analyser.frequencyBinCount;
                const dataArray = new Uint8Array(bufferLength);

                analyserRef.current = analyser;
                dataArrayRef.current = dataArray;

                track.connect(analyser);
                analyser.connect(audioContext.destination);
                setIsAudioPlaying(true);

            } catch (error) {
                console.error('Error setting up audio context:', error);
            }
        }
    };

    useEffect(() => {
        const audioEl = audioRef.current;
        if (audioEl) {
            audioEl.addEventListener('play', handleAudioPlay);
            return () => {
                audioEl.removeEventListener('play', handleAudioPlay);
            };
        }
    }, []);

    return (
        <Box
            component="div"
            display="flex"
            justifyContent="center"
            alignItems="center"
        >
            <Stack
                direction="column"
                spacing={0}
                alignItems="center"
                maxWidth="100%"
            >
                {isAudioPlaying && (
                    <Box
                        component={"div"}
                        sx={{
                            width: "100%",
                            height: CANVAS_HEIGHT,
                            flexGrow: 1,
                        }}
                    >
                        <AudioVisualizerCanvas
                            dataArrayRef={dataArrayRef}
                            analyserRef={analyserRef}
                        />
                    </Box>
                )}
                <audio
                    ref={audioRef}
                    crossOrigin="anonymous"
                    controls src={src}
                ></audio>
            </Stack>
        </Box>
    )
};

export default AudioVisualizer;
