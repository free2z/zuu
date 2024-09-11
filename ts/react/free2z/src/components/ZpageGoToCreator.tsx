import { TravelExplore } from "@mui/icons-material";
import { Tooltip, IconButton } from "@mui/material";
import { PageInterface } from "./PageRenderer";
import { useTransitionNavigate } from "../hooks/useTransitionNavigate";

export default function ZpageGoToCreator(props: PageInterface) {
    const navigate = useTransitionNavigate()
    return (
        <Tooltip title={`See more from ${props.creator.username}`}
            placement="left"
        >
            <IconButton
                size="large"
                // variant="outlined"
                onClick={() => {
                    navigate(`/${props.creator.username}`)
                }}
                color="secondary"
            >
                <TravelExplore
                    fontSize="large"
                />
            </IconButton>
        </Tooltip>
    )
}