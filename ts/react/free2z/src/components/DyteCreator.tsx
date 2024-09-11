import { useEffect } from "react";

import { DyteMeeting, DyteParticipantsAudio } from "@dytesdk/react-ui-kit";
import { useDyteMeeting } from "@dytesdk/react-web-core";
import { leaveRoomState } from "@dytesdk/web-core";

import { useTransitionNavigate } from "../hooks/useTransitionNavigate";
import { useGlobalState } from "../state/global";


export default function DyteCreator() {
    const { meeting } = useDyteMeeting();
    const navigate = useTransitionNavigate();
    const [creator] = useGlobalState("creator");

    const onRoomLeft = ({ state }: { state: leaveRoomState }) => {
        console.log("ROOM LEFT", state);
        // maybe "left" should count here too
        const doRedirect = state !== "disconnected";
        if (doRedirect) {
            if (creator.username) {
                navigate('/profile');
            } else {
                navigate('/');
            }
        }
    }

    useEffect(() => {
        if (meeting) {
            meeting.self.on('roomLeft', onRoomLeft);
            return () => {
                meeting.self.removeListener('roomLeft', onRoomLeft);
            };
        }
    }, [meeting]);

    return (
        <>
            <DyteParticipantsAudio meeting={meeting} />
            <DyteMeeting meeting={meeting} showSetupScreen={true} />
        </>
    );
}
