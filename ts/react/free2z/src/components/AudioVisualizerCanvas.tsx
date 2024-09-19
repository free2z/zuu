import React, { useRef, useEffect, useState } from 'react';
import { Canvas, extend } from '@react-three/fiber';
import { Mesh, CylinderGeometry } from 'three';
import RotatingCamera from './RotatingCamera';

// Extend THREE to include missing geometries
extend({ CylinderGeometry });

const FFT_SIZE = 1024;

// Visualization constants
const Y_OFFSET = 0.25;
const NUM_BARS = 128;
const BAR_WIDTH = 0.001;
const BAR_HEIGHT = 0.05;
const BAR_SPACING = 0.0001;
const MAX_SCALE = 3500;
const AMPLITUDE_NORMALIZER = 256.0; // Normalizes the amplitude values
const HALF_BARS = NUM_BARS / 2;

type VisualizerProps = {
    dataArrayRef: React.RefObject<Uint8Array>;
    analyserRef: React.RefObject<AnalyserNode>;
};

const mapAmplitudeToColor = (amplitude: number): string => {
    // Interpolating the hue value from blue (240) to red (0)
    const hue = 240 - (amplitude * 240);
    return `hsl(${hue}, 100%, 50%)`;
};

const Bar: React.FC<{
    position: [number, number, number],
    scale: [number, number, number],
    color: string,
}> = ({ position, scale, color }) => {
    const meshRef = useRef<Mesh>(null);
    const borderMeshRef = useRef<Mesh>(null);

    useEffect(() => {
        if (meshRef.current && borderMeshRef.current) {
            meshRef.current.scale.set(scale[0], scale[1], scale[2]);
            borderMeshRef.current.scale.set(scale[0] * 1.01, scale[1] * 1.01, scale[2] * 1.01);
        }
    }, [scale]);

    return (
        <>
            {/* Use the extended CylinderGeometry */}
            <mesh ref={borderMeshRef} position={position}>
                <cylinderGeometry args={[BAR_WIDTH * 1.05, BAR_WIDTH * 1.05, BAR_HEIGHT * 1.05, 32]} />
                <meshStandardMaterial color={'black'} transparent opacity={0.15} />
            </mesh>
            <mesh ref={meshRef} position={position}>
                <cylinderGeometry args={[BAR_WIDTH, BAR_WIDTH, BAR_HEIGHT, 32]} />
                <meshStandardMaterial color={color} />
            </mesh>
        </>
    );
};

const AudioVisualizerCanvas: React.FC<VisualizerProps> = ({ dataArrayRef, analyserRef }) => {
    const [bars, setBars] = useState<Array<{
        scale: [number, number, number],
        color: string,
    }>>(Array(NUM_BARS).fill({
        scale: [1, 1, 1],
        color: 'hsl(0, 100%, 50%)',
    }));

    const animateRAF = useRef<number>(0);

    const mapBarToFrequencyBin = (index: number, totalBars: number, sampleRate: number) => {
        const minHz = 22.5;
        const maxHz = sampleRate;
        const indexNormalized = index / totalBars;

        // Using a logarithmic scale to allocate more bars to lower frequencies
        const exponent = (Math.log(maxHz / minHz) * indexNormalized);
        const freq = minHz * Math.exp(exponent);
        const bin = Math.floor(freq / sampleRate * FFT_SIZE);

        return bin;
    };

    const animate = () => {
        if (analyserRef.current && dataArrayRef.current) {
            analyserRef.current.getByteFrequencyData(dataArrayRef.current);
            const sampleRate = analyserRef.current.context.sampleRate;
            const newScales = Array.from({ length: NUM_BARS }, (_, index) => {
                const binIndex = mapBarToFrequencyBin(index, NUM_BARS, sampleRate);
                const amplitude = dataArrayRef.current ? dataArrayRef.current[binIndex] : 0;
                const normalizedAmplitude = amplitude / AMPLITUDE_NORMALIZER;
                const scale = normalizedAmplitude * MAX_SCALE;
                const color = mapAmplitudeToColor(normalizedAmplitude);
                return { scale: [scale, 1, scale] as [number, number, number], color };
            });
            setBars(newScales);
        }
        animateRAF.current = requestAnimationFrame(animate);
    };

    useEffect(() => {
        animate();
        return () => {
            if (animateRAF.current) {
                cancelAnimationFrame(animateRAF.current);
            }
        };
    }, []);

    const barPositions = Array.from({ length: NUM_BARS }, (_, i) => {
        const yPos = (i - HALF_BARS) * (BAR_HEIGHT + BAR_SPACING) + Y_OFFSET;
        const zPos = i / NUM_BARS * 2;
        return [0, yPos, zPos] as [number, number, number];
    });

    const requestFullScreen = (element: HTMLElement) => {
        if (element.requestFullscreen) {
            element.requestFullscreen();
        }
    };

    return (
        <Canvas
            onClick={(ev) => requestFullScreen(ev.currentTarget)}
            style={{ cursor: 'pointer' }}
        >
            <ambientLight />
            <pointLight position={[10, 10, 10]} />
            {bars.map((bar, index) => (
                <Bar
                    key={index}
                    position={barPositions[index]}
                    scale={bar.scale}
                    color={bar.color}
                />
            ))}
            <RotatingCamera />
        </Canvas>
    );
};

export default AudioVisualizerCanvas;
