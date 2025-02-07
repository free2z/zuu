import { Canvas } from '@react-three/fiber';
import { OrbitControls, Stars, Text3D } from "@react-three/drei";
import { Physics, usePlane, useBox, useSphere } from "@react-three/cannon";
import { useMemo } from 'react';
import { BufferGeometry, Mesh, BoxGeometry, TorusGeometry } from 'three';
import { extend } from '@react-three/fiber';

// Extend THREE to include missing geometries
extend({ BoxGeometry, TorusGeometry });

function Toruso() {
    const [ref] = useSphere(() => ({ mass: 1, position: [0, 80, -3] }));

    return (
        <mesh ref={ref as React.RefObject<Mesh<BufferGeometry>>} position={[0, 80, -3]}>
            <torusGeometry args={[1, 0.4, 16, 100]} />
            <meshLambertMaterial color="rebeccapurple" />
        </mesh>
    );
}

function Sphero() {
    const [ref] = useSphere(() => ({ mass: 1, position: [0, 50, -7] }));

    return (
        <mesh ref={ref as React.RefObject<Mesh<BufferGeometry>>} position={[0, 50, -7]}>
            <sphereGeometry args={[1, 32, 32]} />
            <meshLambertMaterial color="salmon" />
        </mesh>
    );
}

function Box() {
    const [ref, api] = useBox(() => ({ mass: 1, position: [0, 20, -5] }));

    return (
        <mesh
            ref={ref as React.RefObject<Mesh<BufferGeometry>>}
            position={[0, 20, -2]}
            onClick={() => api.velocity.set(Math.random(), 2, Math.random())}
        >
            <boxGeometry args={[1, 1, 1]} />
            <meshLambertMaterial color="hotpink" />
        </mesh>
    );
}

function Text404() {
    const [ref] = useSphere(() => ({ mass: 1000, position: [-1, 10, -30] }));

    return (
        <Text3D
            ref={ref as React.RefObject<Mesh<BufferGeometry>>}
            font="/Roboto_Regular.json"
            position={[-1, 10, -10]}
        >
            {"404"}
            <meshNormalMaterial />
        </Text3D>
    );
}

function Plane() {
    const [ref] = usePlane(() => ({
        rotation: [-Math.PI / 2 + 0.08, 0, 0],
        position: [0, -2, 0]
    }));

    return (
        <mesh ref={ref as React.RefObject<Mesh<BufferGeometry>>} rotation={[-Math.PI / 2 + 0.08, 0, 0]} position={[0, -2, 0]}>
            <planeGeometry args={[100, 100]} />
            <meshLambertMaterial color="lightblue" />
        </mesh>
    );
}

enum Controls {
    forward = 'forward',
    back = 'back',
    left = 'left',
    right = 'right',
    jump = 'jump',
}

export default function Global404() {
    const map = useMemo(() => [
        { name: Controls.forward, keys: ['ArrowUp', 'w', 'W'] },
        { name: Controls.back, keys: ['ArrowDown', 's', 'S'] },
        { name: Controls.left, keys: ['ArrowLeft', 'a', 'A'] },
        { name: Controls.right, keys: ['ArrowRight', 'd', 'D'] },
        { name: Controls.jump, keys: ['Space'] },
    ], []);

    return (
        <div style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
        }}>
            <Canvas style={{ height: "100vh", backgroundColor: "black" }}>
                <OrbitControls />
                <Stars />
                <ambientLight intensity={1} />
                <spotLight position={[0, 0, 0]} angle={0.3} intensity={1} castShadow />
                <directionalLight position={[5, 10, 5]} intensity={5} castShadow />
                <Physics>
                    <Text404 />
                    <Toruso />
                    <Box />
                    <Sphero />
                    <Plane />
                </Physics>
            </Canvas>
        </div>
    );
}
