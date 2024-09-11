import { Verified, Share } from "@mui/icons-material";
import { Badge, IconButton, styled, Tooltip } from "@mui/material";
import { RWebShare } from "react-web-share";
import { PublicCreator } from "../CreatorDetail";
import { ReactNode } from "react";


export const CenterBadge = styled(Badge)(({ theme }) => ({
    "& .MuiBadge-badge": {
        right: 7,
        top: 15,
        // border: `2px solid ${theme.palette.background.paper}`,
        // padding: "0 4px",
        whiteSpace: "nowrap",
    },
}))


export default function ShareCreator(props: PublicCreator & { children?: ReactNode }) {
    const { children = (
        <Tooltip title="Share">
            <IconButton
            // size="large"
            >
                <CenterBadge
                    badgeContent={
                        props.is_verified && (
                            <div
                                style={{
                                    fontSize: "13",
                                }}
                            >
                                <Verified
                                    fontSize="inherit"
                                    color="warning"
                                />
                            </div>
                        )
                    }
                >
                    <Share color="primary" />
                </CenterBadge>
            </IconButton>
        </Tooltip>
    ) } = props
    const best_name = props.full_name || props.username
    return (

        <RWebShare
            data={{
                url: window.location.href,
                title: best_name,
                text: `Check out "${best_name}" on free2z!`,
            }}
            onClick={() => console.log("shared successfully!")}
        >
            {children}
        </RWebShare>
    );
};
