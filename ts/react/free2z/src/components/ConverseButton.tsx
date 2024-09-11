import { Stream } from "@mui/icons-material";
import { Tooltip, IconButton } from "@mui/material";
import { useLocation } from "react-router-dom";
import TransitionLink from "./TransitionLink";

export default function ConverseButton() {
    const location = useLocation();

    if (location.pathname === "/converse") {
        return null;
    }
    return (
        <Tooltip title="Converse">
            <IconButton
                to="/converse"
                size="large"
                component={TransitionLink}
            >
                <Stream
                    color="primary"
                />
            </IconButton>
        </Tooltip>
    );
}