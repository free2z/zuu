import { Home } from "@mui/icons-material";
import { Tooltip, IconButton } from "@mui/material";
import { useLocation } from "react-router-dom";
import TransitionLink from "./TransitionLink";

export default function HomeButton() {
    const location = useLocation();

    if (location.pathname === "/") {
        return null;
    }
    return (
        <Tooltip title="Home">
            <IconButton
                to="/"
                size="large"
                component={TransitionLink}
            >
                <Home
                    color="primary"
                />
            </IconButton>
        </Tooltip>
    );
}