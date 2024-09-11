import { useQuery } from 'react-query';
import { LiveTvSharp } from "@mui/icons-material";
import { Badge, IconButton, Tooltip } from "@mui/material";
import axios from "axios";
import { PublicCreator } from "../CreatorDetail";
// import TransitionLink from "./TransitionLink";
import JoinStreamConfirmDialog from './JoinStreamConfirmDialog';
import { useState } from 'react';
import { useTransitionNavigate } from '../hooks/useTransitionNavigate';

export interface LiveMeetingInfo {
    meeting_id: string;
    participants: number;
    price_per_minute: number;
}

export interface LiveMeetings {
    [key: string]: LiveMeetingInfo;
}


const fetchLiveMeetings = async (username: string): Promise<LiveMeetings> => {
    const { data } = await axios.get(`/api/dyte/${username}/live-status`);
    return data;
};

export default function JoinLivestream(star: PublicCreator & { largeIcon?: boolean }) {
    const { data: liveMeetings, isFetching } = useQuery<LiveMeetings, Error>(
        ['liveMeetings', star.username],
        () => fetchLiveMeetings(star.username),
        {
            enabled: !!star.username, // query will not execute until the username exists
            refetchInterval: 15000, // refetch the data every 15 seconds
        }
    );
    const { largeIcon } = star

    // State to manage ConfirmDialog visibility
    const [openConfirmDialog, setOpenConfirmDialog] = useState(false);
    // const [selectedStreamType, setSelectedStreamType] = useState(null);
    const navigate = useTransitionNavigate();

    // Function to handle live TV click
    const handleLiveTvClick = () => {
        if (liveMeetings) {
            const meetingTypes = Object.keys(liveMeetings);
            const isPPV = meetingTypes.includes('ppv');

            // If there's more than one stream or a PPV, show the confirm dialog
            if (meetingTypes.length > 1 || isPPV) {
                setOpenConfirmDialog(true);
            } else if (meetingTypes.length === 1) {
                const type = meetingTypes[0];
                navigate(`/${star.username}/${type}`);
            }
        }
    };

    // Function to close ConfirmDialog and navigate to selected stream
    const handleConfirmAndJoin = (type: string) => {
        setOpenConfirmDialog(false);
        navigate(`/${star.username}/${type}`);
    };

    // change to 0 when dyte fixes regression
    // https://discord.com/channels/872824138048352277/1253228307227349004
    const totalParticipants = liveMeetings ?
        Object.values(liveMeetings).reduce((sum, { participants }) => sum + participants, 0)
        : 0;
    let liveTvIcon

    if (totalParticipants) {
        liveTvIcon = (
            <Tooltip title="Join livestream">
                <span>
                    <IconButton
                        onClick={handleLiveTvClick}
                        color="warning"
                        disabled={!totalParticipants}
                    >
                        <Badge badgeContent={totalParticipants} color="success">
                            <LiveTvSharp sx={{ fontSize: largeIcon ? "32px" : undefined }} />
                        </Badge>
                    </IconButton>
                </span>
            </Tooltip>
        );
    } else {
        liveTvIcon = (
            <Tooltip title="No livestream now">
                <span>
                    <IconButton sx={{ py: "0px" }} disabled>
                        <LiveTvSharp sx={{ fontSize: largeIcon ? "32px" : undefined }} />
                    </IconButton>
                </span>
            </Tooltip>
        );
    }

    return (
        <div>
            {liveTvIcon}
            <JoinStreamConfirmDialog
                open={openConfirmDialog}
                onClose={() => setOpenConfirmDialog(false)}
                onConfirm={handleConfirmAndJoin}
                liveMeetings={liveMeetings || {}}
            />
        </div>
    );
}