import { Tooltip, IconButton } from "@mui/material"
import { useLocation } from "react-router-dom"
import TransitionLink from "./TransitionLink"
import { Search } from "@mui/icons-material"


export default function FindButton() {
    const location = useLocation()
    if (location.pathname === "/find") return null

    return (
        <Tooltip title="Find Creators">
            <IconButton
                size="large"
                color="secondary"
                to="/find"
                component={TransitionLink}
            >
                <Search />
            </IconButton>
        </Tooltip>
    )
}
