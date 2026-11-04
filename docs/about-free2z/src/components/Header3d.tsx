import React, { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

const words = [
  "Create",
  "Speak",
  "Publish",
  "Share",
  "Connect",
  "Build",
  "Learn",
  "Stream",
  "Imagine",
];
const colors = ["#dec7ff", "#ffafd7", "#a6ecf5"];

function FloatingWord({ text, index }: { text: string; index: number }) {
  const sprite = useRef<THREE.Sprite>(null);
  const elapsed = useRef(0);
  const { viewport } = useThree();
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 768;
    canvas.height = 144;
    const context = canvas.getContext("2d");
    if (context) {
      context.font = "600 90px system-ui, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillStyle = colors[index % colors.length];
      context.fillText(text, 384, 72);
    }
    const result = new THREE.CanvasTexture(canvas);
    result.colorSpace = THREE.SRGBColorSpace;
    return result;
  }, [text, index]);
  useEffect(() => () => texture.dispose(), [texture]);

  useFrame((_, delta) => {
    elapsed.current += Math.min(delta, 0.05);
    if (!sprite.current) return;
    const column = index % 3;
    const row = Math.floor(index / 3);
    const phase = elapsed.current * 0.25 + index * 1.7;
    sprite.current.position.set(
      (column - 1) * viewport.width * 0.24 + Math.sin(phase) * 0.2,
      (1 - row) * viewport.height * 0.23 + Math.cos(phase * 0.8) * 0.18,
      Math.sin(phase * 0.6) * 1.5,
    );
    sprite.current.material.opacity = 0.65 + (Math.sin(phase) + 1) * 0.15;
  });

  return (
    <sprite ref={sprite} scale={[Math.min(viewport.width * 0.4, 3.8), 0.72, 1]}>
      <spriteMaterial map={texture} transparent depthWrite={false} />
    </sprite>
  );
}

function WordField() {
  const { viewport } = useThree();
  const stars = useMemo(() => {
    const positions = new Float32Array(120);
    for (let index = 0; index < 40; index++) {
      positions[index * 3] = Math.sin(index * 12.9898) * viewport.width * 0.48;
      positions[index * 3 + 1] =
        Math.cos(index * 7.233) * viewport.height * 0.48;
      positions[index * 3 + 2] = -3;
    }
    return positions;
  }, [viewport.width, viewport.height]);
  return (
    <>
      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[stars, 3]} />
        </bufferGeometry>
        <pointsMaterial
          color="#b9a9ee"
          size={0.035}
          transparent
          opacity={0.5}
        />
      </points>
      {words.map((text, index) => (
        <FloatingWord key={text} text={text} index={index} />
      ))}
    </>
  );
}

class SceneBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Decorative, bounded word field. The real heading and controls remain in HTML. */
export default function Header3d({ active }: { active: boolean }): JSX.Element {
  const fallback = (
    <div
      style={{
        height: "100%",
        display: "grid",
        placeContent: "center",
        textAlign: "center",
        color: "#dec7ff",
        fontSize: "1.3rem",
        lineHeight: 2.5,
      }}
    >
      Create · Publish · Connect
      <br />
      Share · Build · Imagine
    </div>
  );
  if (!active) return fallback;
  return (
    <SceneBoundary fallback={fallback}>
      <Canvas
        orthographic
        camera={{ position: [0, 0, 10], zoom: 50 }}
        dpr={[1, 1.5]}
        frameloop="always"
        gl={{ alpha: true, antialias: true, powerPreference: "low-power" }}
        fallback={fallback}
        style={{ pointerEvents: "none" }}
      >
        <WordField />
      </Canvas>
    </SceneBoundary>
  );
}
