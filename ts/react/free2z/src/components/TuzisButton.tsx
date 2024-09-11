import { Agriculture } from "@mui/icons-material";
import { Badge, IconButton, styled, Tooltip, Typography, useTheme } from "@mui/material";
import React from "react";
import { Creator } from "../Begin";
import TuzisDialog from "./TuzisDialog";


export const SBadge = styled(Badge)(({ theme }) => ({
    "& .MuiBadge-badge": {
        // right: -27,
        right: 19,
        top: 45,
        border: `1px solid ${theme.palette.primary.main}`,
        padding: "0 4px",
        whiteSpace: "nowrap",
        backgroundColor: "rgb(0,0,0,0)",
        // fontWeight: "100",
        // (theme.palette.background.paper,
        // opacity: 0.5,
        // color: theme.palette.mode === "light" ? "black" : "white",
        // color: theme.palette.mode === "light" ? "#000" : "#fff",
    },
    // "& .MuiTypography-root": {
    //     opacity: 1, // Set the opacity of the text to 1 (fully opaque)
    // },
}))


export default function TuzisButton(props: Creator) {
    const theme = useTheme()
    const [open, setOpen] = React.useState(false)

    const handleClickOpen = () => {
        setOpen(true)
    }

    const bal = Number(props.tuzis).toFixed(0)
    return (
        <>
            <TuzisDialog open={open} setOpen={setOpen} {...props} />
            <Tooltip title={`Buy 2Zs, you have ${bal}`} placement="bottom">
                <IconButton
                    onClick={handleClickOpen}
                    size="large"
                >
                    <SBadge
                        badgeContent={
                            <Typography
                                variant="button"
                                style={{
                                    fontWeight: "900"
                                }}
                            >
                                {bal}
                            </Typography>
                        }
                        max={999999}
                    >
                        <Agriculture
                            fontSize="large"
                            color="info"
                        />
                    </SBadge>
                </IconButton>
            </Tooltip>
        </>
    );
};
