import { Tooltip, IconButton } from "@mui/material";
import { useLocation } from "react-router-dom";
import TransitionLink from "./TransitionLink";
import { AutoMode, Psychology, PsychologyAltOutlined, PsychologyAltTwoTone, PsychologyOutlined, QuestionAnswer, SelfImprovement } from "@mui/icons-material";

export default function AIPublicFeedButton() {
    const location = useLocation();

    if (location.pathname.startsWith("/ai/public")) {
        return null;
    }
    return (
        <Tooltip title="Public AI">
            <IconButton
                to="/ai/public"
                size="large"
                component={TransitionLink}
            >
                <Psychology
                    color="info"
                />
            </IconButton>
        </Tooltip>
    );
}