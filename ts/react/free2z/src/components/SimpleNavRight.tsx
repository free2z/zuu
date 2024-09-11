import { Hive } from "@mui/icons-material"
import { Box, Stack, Tooltip, IconButton } from "@mui/material"
import AvatarMenu from "./AvatarMenu"
import BadgeNotification from "./BadgeNotification"
import { useQuery } from "react-query";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import { useGlobalState } from "../state/global";

async function fetchHasEvents() {
    const response = await axios.get('/api/events/has/')
    return response.data;
}

export default function SimpleNavRight() {
    const [creator, setCreator] = useGlobalState("creator")
    const navigate = useNavigate();
    const isSuperSmall = window.innerWidth < 325

    const {
        data: hasEvents,
        // isLoading,
        // isError
    } = useQuery("hasEvents", fetchHasEvents, {
        enabled: !!creator.username,
        staleTime: 1000 * 60 * 60,  // The query will not become stale for an hour
        cacheTime: Infinity  // The cache will not be garbage collected unless explicitly removed
    });


    return (
        <Box
            // alignItems="right"
            component="div"
            display="flex"
            justifyContent="flex-end"
        >
            <Stack direction="row"
                // alignItems={"right"}
                // alignContent="right"
                // alignItems="right"
                // justifyContent="flex-end"
                // justifyItems="flex-end"
                spacing={{
                    xs: isSuperSmall ? -1 : -0.5,
                    sm: 1,
                    md: 2,
                    lg: 3,
                    xl: 4,
                }}
            >
                {hasEvents &&
                    <Box component="div" display="flex" alignItems="center">
                        <Tooltip title="Notifications">
                            <IconButton
                                onClick={() => {
                                    navigate("/events/")
                                }}
                            >
                                <div
                                    style={{
                                        width: '30px',
                                        height: '30px',
                                        position: 'relative',
                                        transform: 'translate(-16.67%, -16.67%)',
                                    }}
                                >
                                    <BadgeNotification>
                                        <Hive
                                            color="error"
                                            fontSize="large"
                                            style={{
                                                // padding: '6px',
                                                opacity: 0.9,
                                            }}
                                        />
                                    </BadgeNotification>
                                </div>
                            </IconButton>
                        </Tooltip>
                    </Box>
                }
                <AvatarMenu />
            </Stack>
        </Box>
    )
}