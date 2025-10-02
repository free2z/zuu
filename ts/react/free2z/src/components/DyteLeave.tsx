import { useRealtimeKitMeeting } from "@cloudflare/realtimekit-react";
import { useEffect } from "react";


export default function DyteLeave() {
    const { meeting } = useRealtimeKitMeeting()

    useEffect(() => {
        const handleBeforeUnload = (event: BeforeUnloadEvent) => {
            // console.log("HANDLEBREFOREUNLOAD", event)
            event.preventDefault();
            event.returnValue = '';
            if (event.returnValue !== "") {
                // if confirmed
                meeting.leaveRoom('left')
            }
        };
        window.addEventListener('beforeunload', handleBeforeUnload)
        // window.addEventListener('popstate', handleBeforeUnload)
        return () => {
            window.removeEventListener('beforeunload', handleBeforeUnload)
            // window.removeEventListener('popstate', handleBeforeUnload)
        };
    }, []);

    // TODO: preventing the back button is actually a lot harder
    // than you think :D
    useEffect(() => {
        // const href = window.location.href
        const handlePopState = (event: PopStateEvent) => {
            // Well, it's not easy to intercept it turns out;
            // but, at least we can leave?
            meeting.leaveRoom('left')
            // console.log("handlepopstate", event)
            // event.preventDefault()
            // event.stopPropagation()
            // // event.returnValue = ""
            // // event.
            // const result = window.confirm('Are you sure you want to leave?')
            // console.log("RESULT", result)
            // if (result) {
            //     console.log("HANDLEPOPSTATE LEAVE")
            //     meeting.leaveRoom('left')
            // } else {
            //     console.log("STAYING", href)
            //     window.history.pushState(null, '', href);
            // }
        };
        window.addEventListener('popstate', handlePopState);

        // TODO hrmmmmm
        // return () => {
        //     window.removeEventListener('popstate', handlePopState);
        // };
    }, []);

    return null
}
