// https://www.youtube.com/watch?v=9ZEjSxDRIik
import { Canvas } from '@react-three/fiber'
import { KeyboardControls, KeyboardControlsEntry, OrbitControls, Sphere, Stars, Text3D, Torus } from "@react-three/drei";
import { Physics, usePlane, useBox, useSphere } from "@react-three/cannon";
import { useMemo } from 'react';
import { BufferGeometry, Mesh, Object3D } from 'three';


function Toruso() {
    const [ref, api] = useSphere(() => ({ mass: 1, position: [0, 80, -3] }));

    return (
        <mesh
            ref={ ref as React.RefObject<Mesh<BufferGeometry>>}
            position={[0, 80, -3]}
        >
            <Torus key={undefined} position={undefined} material={undefined} userData={undefined} rotation={undefined} attach={undefined} onUpdate={undefined} up={undefined} scale={undefined} matrix={undefined} quaternion={undefined} layers={undefined} dispose={undefined} clear={undefined} geometry={undefined} raycast={undefined} onClick={undefined} onContextMenu={undefined} onDoubleClick={undefined} onPointerUp={undefined} onPointerDown={undefined} onPointerOver={undefined} onPointerOut={undefined} onPointerEnter={undefined} onPointerLeave={undefined} onPointerMove={undefined} onPointerMissed={undefined} onPointerCancel={undefined} onWheel={undefined} type={undefined} visible={undefined} id={undefined} uuid={undefined} name={undefined} parent={undefined} modelViewMatrix={undefined} normalMatrix={undefined} matrixWorld={undefined} matrixAutoUpdate={undefined} matrixWorldNeedsUpdate={undefined} castShadow={undefined} receiveShadow={undefined} frustumCulled={undefined} renderOrder={undefined} animations={undefined} customDepthMaterial={undefined} customDistanceMaterial={undefined} isObject3D={undefined} onBeforeRender={undefined} onAfterRender={undefined} applyMatrix4={undefined} applyQuaternion={undefined} setRotationFromAxisAngle={undefined} setRotationFromEuler={undefined} setRotationFromMatrix={undefined} setRotationFromQuaternion={undefined} rotateOnAxis={undefined} rotateOnWorldAxis={undefined} rotateX={undefined} rotateY={undefined} rotateZ={undefined} translateOnAxis={undefined} translateX={undefined} translateY={undefined} translateZ={undefined} localToWorld={undefined} worldToLocal={undefined} lookAt={undefined} add={undefined} remove={undefined} removeFromParent={undefined} getObjectById={undefined} getObjectByName={undefined} getObjectByProperty={undefined} getWorldPosition={undefined} getWorldQuaternion={undefined} getWorldScale={undefined} getWorldDirection={undefined} traverse={undefined} traverseVisible={undefined} traverseAncestors={undefined} updateMatrix={undefined} updateMatrixWorld={undefined} updateWorldMatrix={undefined} toJSON={undefined} clone={undefined} copy={undefined} addEventListener={undefined} hasEventListener={undefined} removeEventListener={undefined} dispatchEvent={undefined} morphTargetInfluences={undefined} morphTargetDictionary={undefined} isMesh={undefined} updateMorphTargets={undefined} matrixWorldAutoUpdate={undefined} getObjectsByProperty={undefined} getVertexPosition={undefined}>
                {/* <meshBasicMaterial color="rebeccapurple" /> */}
                <meshLambertMaterial attach="material" color="rebeccapurple" />

            </Torus>
        </mesh>
    )
}


function Sphero() {
    const [ref, api] = useSphere(() => ({ mass: 1, position: [0, 50, -7] }));

    return (
        <mesh
            ref={ref as React.RefObject<Mesh<BufferGeometry>>}
            position={[0, 50, -7]}
        >
            <Sphere key={undefined} position={undefined} material={undefined} userData={undefined} rotation={undefined} attach={undefined} onUpdate={undefined} up={undefined} scale={undefined} matrix={undefined} quaternion={undefined} layers={undefined} dispose={undefined} onClick={undefined} onContextMenu={undefined} onDoubleClick={undefined} onPointerUp={undefined} onPointerDown={undefined} onPointerOver={undefined} onPointerOut={undefined} onPointerEnter={undefined} onPointerLeave={undefined} onPointerMove={undefined} onPointerMissed={undefined} onPointerCancel={undefined} onWheel={undefined} visible={undefined} type={undefined} id={undefined} uuid={undefined} name={undefined} parent={undefined} modelViewMatrix={undefined} normalMatrix={undefined} matrixWorld={undefined} matrixAutoUpdate={undefined} matrixWorldNeedsUpdate={undefined} castShadow={undefined} receiveShadow={undefined} frustumCulled={undefined} renderOrder={undefined} animations={undefined} customDepthMaterial={undefined} customDistanceMaterial={undefined} isObject3D={undefined} onBeforeRender={undefined} onAfterRender={undefined} applyMatrix4={undefined} applyQuaternion={undefined} setRotationFromAxisAngle={undefined} setRotationFromEuler={undefined} setRotationFromMatrix={undefined} setRotationFromQuaternion={undefined} rotateOnAxis={undefined} rotateOnWorldAxis={undefined} rotateX={undefined} rotateY={undefined} rotateZ={undefined} translateOnAxis={undefined} translateX={undefined} translateY={undefined} translateZ={undefined} localToWorld={undefined} worldToLocal={undefined} lookAt={undefined} add={undefined} remove={undefined} removeFromParent={undefined} clear={undefined} getObjectById={undefined} getObjectByName={undefined} getObjectByProperty={undefined} getWorldPosition={undefined} getWorldQuaternion={undefined} getWorldScale={undefined} getWorldDirection={undefined} raycast={undefined} traverse={undefined} traverseVisible={undefined} traverseAncestors={undefined} updateMatrix={undefined} updateMatrixWorld={undefined} updateWorldMatrix={undefined} toJSON={undefined} clone={undefined} copy={undefined} addEventListener={undefined} hasEventListener={undefined} removeEventListener={undefined} dispatchEvent={undefined} geometry={undefined} morphTargetInfluences={undefined} morphTargetDictionary={undefined} isMesh={undefined} updateMorphTargets={undefined} matrixWorldAutoUpdate={undefined} getObjectsByProperty={undefined} getVertexPosition={undefined}>
                {/* <meshBasicMaterial color="salmon" /> */}
                <meshLambertMaterial attach="material" color="salmon" />

            </Sphere>
        </mesh>
    )
}

function Box() {
    const [ref, api] = useBox(() => ({ mass: 1, position: [0, 20, -5] }));
    return (
        <mesh
            onClick={() => {
                api.velocity.set(Math.random(), 2, Math.random());
            }}
            ref={ref as React.RefObject<Mesh<BufferGeometry>>}
            position={[0, 20, -2]}
        // rotation={[1, Math.PI / 3, 2]}
        // quaternion={THREE.Quarternion}
        >
            <boxBufferGeometry attach="geometry" />
            <meshLambertMaterial attach="material" color="hotpink" />
        </mesh>
    );
}

function Text404() {
    const [ref, api] = useSphere(() => ({ mass: 1000, position: [-1, 10, -30] }));

    return (
        // <mesh
        // // ref={ref}
        // >


        <Text3D
            key={undefined} material={undefined} userData={undefined} attach={undefined} args={undefined} onUpdate={undefined} clear={undefined} geometry={undefined} raycast={undefined} type={undefined} visible={undefined} id={undefined} uuid={undefined} name={undefined} parent={undefined} modelViewMatrix={undefined} normalMatrix={undefined} matrixWorld={undefined} matrixAutoUpdate={undefined} matrixWorldNeedsUpdate={undefined} castShadow={undefined} receiveShadow={undefined} frustumCulled={undefined} renderOrder={undefined} animations={undefined} customDepthMaterial={undefined} customDistanceMaterial={undefined} isObject3D={undefined} onBeforeRender={undefined} onAfterRender={undefined} applyMatrix4={undefined} applyQuaternion={undefined} setRotationFromAxisAngle={undefined} setRotationFromEuler={undefined} setRotationFromMatrix={undefined} setRotationFromQuaternion={undefined} rotateOnAxis={undefined} rotateOnWorldAxis={undefined} rotateX={undefined} rotateY={undefined} rotateZ={undefined} translateOnAxis={undefined} translateX={undefined} translateY={undefined} translateZ={undefined} localToWorld={undefined} worldToLocal={undefined} lookAt={undefined} add={undefined} remove={undefined} removeFromParent={undefined} getObjectById={undefined} getObjectByName={undefined} getObjectByProperty={undefined} getWorldPosition={undefined} getWorldQuaternion={undefined} getWorldScale={undefined} getWorldDirection={undefined} traverse={undefined} traverseVisible={undefined} traverseAncestors={undefined} updateMatrix={undefined} updateMatrixWorld={undefined} updateWorldMatrix={undefined} toJSON={undefined} clone={undefined} copy={undefined} addEventListener={undefined} hasEventListener={undefined} removeEventListener={undefined} dispatchEvent={undefined} morphTargetInfluences={undefined} morphTargetDictionary={undefined} isMesh={undefined} updateMorphTargets={undefined}
            position={[-1, 10, -10]}
            // https://www.fontsquirrel.com/fonts/list/popular
            // http://gero3.github.io/facetype.js/
            // https://panzoid.com/community/5802
            font={"/Roboto_Regular.json"}
            ref={ref as React.RefObject<Mesh<BufferGeometry>>} matrixWorldAutoUpdate={undefined} getObjectsByProperty={undefined} getVertexPosition={undefined}        >
            {"404"}
            <meshNormalMaterial />
        </Text3D>
        // </mesh>
    )
}

function Plane() {
    const [ref] = usePlane(() => ({
        rotation: [-Math.PI / 2 + 0.08, 0, 0],
        position: [0, -2, 0]
    }));
    return (
        <mesh
            ref={ref as React.RefObject<Mesh<BufferGeometry>>}
            rotation={[-Math.PI / 2 + 0.08, 0, 0]}
            position={[0, -2, 0]}
        >
            <planeBufferGeometry attach="geometry" args={[100, 100]} />
            <meshLambertMaterial attach="material" color="lightblue" />
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
    const map = useMemo<KeyboardControlsEntry<Controls>[]>(() => [
        { name: Controls.forward, keys: ['ArrowUp', 'w', 'W'] },
        { name: Controls.back, keys: ['ArrowDown', 's', 'S'] },
        { name: Controls.left, keys: ['ArrowLeft', 'a', 'A'] },
        { name: Controls.right, keys: ['ArrowRight', 'd', 'D'] },
        { name: Controls.jump, keys: ['Space'] },
    ], [])

    return (
        // <KeyboardControls map={map}>
        <Canvas style={{
            height: "100vh",
            backgroundColor: "black",
        }}>


            <OrbitControls />

            <Stars />
            <ambientLight intensity={0.5} />
            <spotLight position={[10, 15, 10]} angle={0.3} />
            <Physics>
                <Text404 />
                <Toruso />
                <Box />
                <Sphero />
                <Plane />
            </Physics>
        </Canvas>
        // </KeyboardControls>
    )
}
