import RedirectUnauthed from "./components/RedirectUnauthed";
import StoryNew from "./components/StoryNew";
import StoryYours from "./components/StoryYours";
import { useGlobalState } from "./state/global";

export default function StoryTime() {
    const [creator, setCreator] = useGlobalState("creator")

    if (!creator.username) return <RedirectUnauthed />

    return (
        <>
            <StoryNew />
            <StoryYours />
        </>
    )
}
