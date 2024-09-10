import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Text, Stars } from '@react-three/drei';
import * as THREE from 'three';

const NEXT_WORD_INTERVAL = 677;
const MOVEMENT_MAGNITUDE = new THREE.Vector3(0.027, 0.02, 0.1);
const CAMERA_MOVEMENT_FACTOR = new THREE.Vector3(0.0037, 0.0027, 0.007);
const MOBILE_WORD_FACTOR = 1;

const wordList = [
    "Speak", "Earn",
    "Publish",
    "Create", "Share", "Connect",
    "Discover", "Innovate", "Learn", "Grow", "Build",
    "Stream", "Broadcast", "Record", "Release",
    "Make", "Money",
    "Collaborate", "Inspire", "Teach", "Lead",
    "Donate",
    "Succeed", "Change", "Dream", "Imagine",
    "Achieve", "Contribute", "Empower",
    "Raise funds",
    "Engage", "Challenge", "Unite", "Support",
    "Communicate", "Explore", "Express", "Evolve",
    "Motivate", "Mentor", "Transform", "Impact",
    "Gain",
    "Encourage", "Enrich", "Advance", "Inspire",
    "Envision", "Invent", "Influence", "Create",
    "Advocate", "Activate", "Elevate", "Revolutionize",
    "Pioneer", "Broadcast", "Illuminate", "Navigate",
    "Orchestrate", "Synthesize", "Revitalize", "Reinvent",
    "Facilitate", "Mobilize", "Foster", "Cultivate",
    "Diversify", "Integrate", "Amplify", "Galvanize",
    "Revive", "Rejuvenate", "Resonate", "Liberate",
    "Illustrate", "Redefine", "Champion", "Energize",
    "Intensify", "Meditate", "Question", "Research",
    "Analyze", "Debate", "Report", "Expose",
    "Narrate", "Chronicle", "Document", "Proclaim",
    "Affirm", "Manifest", "Implement", "Reform",
    "Renew", "Pursue", "Thrive", "Visualize",
    "Craft", "Compose", "Design", "Produce",
    "Broadcast", "Stream", "Record", "Release",
    "Perform", "Present", "Interact", "Participate",
    "Distribute", "Publish", "Write", "Edit",
    "Illustrate", "Capture", "Demonstrate", "Protest",
    "Deliberate", "Investigate", "Explore", "Uncover",
    "Reveal", "Disclose", "Dare", "Defy",
    "Question", "Inquire", "Probe", "Examine",
    "Believe", "Trust", "Hope", "Dream",
    "Analyze", "Deconstruct", "Articulate", "Narrate",
    "Persuade", "Negotiate", "Influence", "Show",
    "Prove", "Disprove", "Challenge", "Confront",
    "Exhibit", "Display", "Explain",
    "Enlighten", "Educate", "Advise", "Consult",
    "Guide", "Direct", "Organize", "Plan",
    "Strategize", "Forecast", "Predict", "Model",
    "Simulate", "Experiment", "Test", "Develop",
    "Optimize", "Enhance", "Improve", "Refine",
    "Customize", "Personalize", "Modify", "Adapt",
    "Innovate", "Pioneer", "Trailblaze", "Discover",
    "Venture", "Risk", "Dabble", "Experiment",
    "Tinker", "Hack", "Craft", "Forge",
    "Merge", "Blend", "Combine", "Integrate",
    "Unify", "Harmonize", "Balance", "Align",
    "Coordinate", "Cooperate", "Partner", "Synergize",
    "Connect", "Network", "Link", "Bridge",
    "Unite", "Bond", "Associate", "Engage",
    "Interact", "Socialize", "Commune", "Converse",
    "Dialogue", "Discuss", "Debate", "Argue",
    "Persuade", "Convince", "Enthrall", "Captivate",
    "Entertain", "Amuse", "Delight", "Charm",
    "Enchant", "Fascinate", "Attract", "Allure",
    "Inspire", "Motivate", "Uplift", "Elevate",
    "Empower", "Enrich", "Nourish", "Cultivate",
    "Foster", "Nurture", "Care", "Protect",
    "Defend", "Guard", "Preserve", "Save",
    "Rescue", "Relieve", "Aid", "Assist",
    "Help", "Support", "Back", "Champion",
    "Advocate", "Promote", "Endorse", "Sponsor",
    "Boost", "Elevate", "Strengthen", "Fortify",
]

interface FloatingWordProps {
    text: string;
    initialPosition: THREE.Vector3;
    camera: THREE.Camera;
}

const FloatingWord: React.FC<FloatingWordProps> = ({ text, initialPosition, camera }) => {
    const ref = useRef<THREE.Object3D>(null);
    const time = useRef(0);
    const moveDirection = useRef(new THREE.Vector3(0, 0, 0))

    const isMobile = () => window.innerWidth < 768;
    const factor = isMobile() ? MOBILE_WORD_FACTOR : 1;

    // set movement for word
    moveDirection.current = useMemo(() => new THREE.Vector3(
        (Math.random() - 0.5) * MOVEMENT_MAGNITUDE.x * factor,
        (Math.random() * MOVEMENT_MAGNITUDE.y * factor) + MOVEMENT_MAGNITUDE.y * factor,
        (Math.random() - 0.67) * MOVEMENT_MAGNITUDE.z * factor,
    ), []);

    const { color } = useMemo(() => {
        const red = Math.floor(Math.random() * 256 + 100);
        const blue = Math.floor(Math.random() * 256 + 100);
        const green = Math.floor(Math.random() * 256 + 50);

        const purpleShade = `rgb(${red}, ${green}, ${blue})`;
        return { color: purpleShade };
    }, []);

    const { outlineColor } = useMemo(() => {
        const red = Math.floor(Math.random() * 128);
        const blue = Math.floor(Math.random() * 128);
        const green = Math.floor(Math.random() * 128);
        return { outlineColor: `rgb(${red}, ${green}, ${blue})` };
    }, []);

    const {
        fontSize, fillOpacity,
    } = useMemo(() => {
        return {
            // color: `#${Math.floor(Math.random() * 16777215).toString(16)}`,
            fontSize: Math.random() * 1 + 1, // Random font size between 1 and 2
            fillOpacity: Math.random() * 0.1 + 0.9,
            // letterSpacing: Math.random() * 0.1, // Random letter spacing
            // textAlign: ['left', 'right', 'center', 'justify'][Math.floor(Math.random() * 4)], // Random text alignment
            // outlineWidth: Math.random() * 0.05, // Random outline width
            // outlineColor: `#${Math.floor(Math.random() * 16777215).toString(16)}`, // Random outline color
            // strokeWidth: Math.random() * 0.05, // Random stroke width
            // strokeColor: `#${Math.floor(Math.random() * 16777215).toString(16)}`, // Random stroke color

        };
    }, []);

    useFrame(() => {
        if (ref.current) {
            // Make the text face the camera initially
            // if (time.current < 100) {
            ref.current.lookAt(camera.position);
            // }
            // Move in the random direction
            ref.current.position.add(moveDirection.current);
            // fillOpacity += Math.sin(time.current / 100)
            time.current += 1;
        }
    });

    return (
        <Text
            ref={ref}
            position={initialPosition}
            fontSize={fontSize * (isMobile() ? 0.9 : 1)}
            color={color}
            fillOpacity={fillOpacity}
        >
            {text}
        </Text>

    );
};


function WordsGenerator() {
    const [words, setWords] = useState([]);
    const { camera } = useThree();
    const wordIndex = useRef(0);
    const isMobile = () => window.innerWidth < 768;

    const isUserInteracting = useRef(false); // Ref to track user interaction
    const handleStart = useCallback(() => {
        isUserInteracting.current = true;
    }, []);
    const handleEnd = useCallback(() => {
        isUserInteracting.current = false;
    }, []);

    const cameraDirection = useRef({
        x: Math.random() - 0.5,
        y: Math.random() - 0.5,
        z: Math.random() - 0.5,
        zoom: 1
    });

    // Move the camera
    useFrame(() => {
        if (!isUserInteracting.current) {
            // Randomly change direction and zoom occasionally
            if (Math.random() < 0.005) { // 0.05% chance per frame to change direction
                cameraDirection.current = {
                    x: (Math.random() - 0.5),
                    y: (Math.random() - 0.5),
                    z: (Math.random() - 0.5),
                    // zoom: Math.random() + 0.77,
                    zoom: (Math.random() - 0.5),
                };
            }
            // Update position
            camera.position.x += cameraDirection.current.x * CAMERA_MOVEMENT_FACTOR.x;
            camera.position.y += cameraDirection.current.y * CAMERA_MOVEMENT_FACTOR.y;
            camera.position.z += cameraDirection.current.z * CAMERA_MOVEMENT_FACTOR.z;
            // Apply zoom
            camera.zoom += cameraDirection.current.zoom * 0.001;
            camera.updateProjectionMatrix();
        }
    });

    useEffect(() => {
        const intervalId = setInterval(() => {
            const nextWord = wordList[wordIndex.current % wordList.length];
            wordIndex.current = (wordIndex.current + 1) % wordList.length;
            const direction = new THREE.Vector3();
            camera.getWorldDirection(direction);

            const distance = 10; // Distance in front of the camera
            const position = direction.multiplyScalar(distance).add(camera.position);

            // position.x += Math.random() - 0.5;
            position.y += -5;
            // position.z += -5;
            // const position = new THREE.Vector3(
            //     (Math.random() - 0.5) + camposition.x, // Random x position within a range
            //     camposition.y - 3,
            //     (Math.random() - 0.5) + camposition.z  // Random z position within a range
            // );
            setWords(currentWords => [...currentWords, { text: nextWord, position }]);

        }, NEXT_WORD_INTERVAL * (isMobile() ? 1.25 : 1));

        return () => clearInterval(intervalId);
    }, [camera, isMobile]);

    return (
        <>
            <OrbitControls onStart={handleStart} onEnd={handleEnd} />
            {words.map((word, index) => (
                <FloatingWord
                    key={index} text={word.text}
                    initialPosition={word.position} camera={camera}
                />
            ))}
        </>
    )
}


function My3DComponent() {
    // Create a ref to your canvas
    const canvasRef = useRef<HTMLCanvasElement>(null);

    // Fake mouse event to prevent the throttle
    useEffect(() => {
        // Function to dispatch a fake mousemove event
        const dispatchFakeMouseMove = () => {
            const evt = new MouseEvent("mousemove", {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: 0,
                clientY: 0
            });
            window.dispatchEvent(evt);
        };

        // Set an interval to periodically dispatch the event
        const intervalId = setInterval(dispatchFakeMouseMove, 3000);

        // Clean up the interval when the component unmounts
        return () => clearInterval(intervalId);
    }, []);

    useEffect(() => {
        // When the component mounts, apply the will-change property
        if (canvasRef.current) {
            // Directly set the style on the canvas DOM element
            canvasRef.current.style.willChange = 'transform';
        }

        // Optional: Clean up when the component unmounts
        return () => {
            if (canvasRef.current) {
                canvasRef.current.style.willChange = 'auto';
            }
        };
    }, []);

    return (
        <Canvas ref={canvasRef} style={{
            height: "50vh", willChange: 'transform'
        }}>
            <ambientLight />
            <pointLight position={[10, 10, 10]} />
            <WordsGenerator />
            <Stars />
        </Canvas>
    );
}

export default My3DComponent;
