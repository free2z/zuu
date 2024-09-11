import { OrbitControls } from "@react-three/drei";
import { useThree, useFrame } from "@react-three/fiber";
import { useEffect } from "react";

const RotatingCamera = () => {
    const { camera, gl } = useThree(); // Access camera and gl

    useEffect(() => {
        camera.position.y = 0.1
        camera.position.z = 6.7
    }, [])
    useFrame(({ clock }) => {
        // default is 0, 0, 5

        // camera.position.z = 5
        // camera.position.x = Math.sin(clock.getElapsedTime() * 0.1) * 5; // Adjust the speed and radius as needed
        // camera.position.z = Math.cos(clock.getElapsedTime() * 0.1) * 5;
        camera.lookAt(0, 0, 0); // Focus the camera on the center
    });

    // return <OrbitControls args={[camera, gl.domElement]} />;
    return <></>
};

export default RotatingCamera;
