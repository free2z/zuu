import { ThumbUp, ThumbDown } from "@mui/icons-material";
import { IconButton, Stack, Typography, useTheme } from "@mui/material";
import axios from "axios";
import { useEffect, useState } from "react";
import { useGlobalState } from "../state/global";
import { PageInterface } from "./PageRenderer";

import './UpDownPage.css'

type Props = {
    page: PageInterface,
    noShow?: boolean,
}

export default function UpDownPage(props: Props) {
    const { page } = props;
    const [snack, setSnack] = useGlobalState("snackbar")
    const [creator, _] = useGlobalState("creator")
    const [loginModal, setLoginModal] = useGlobalState("loginModal")
    const [authStatus, setAuthStatus] = useGlobalState("authStatus")
    const theme = useTheme()
    const [isPulsating, setIsPulsating] = useState(false as "up" | "down" | false)
    const [score, setScore] = useState(page.f2z_score)

    const handleVote = (voteType: "up" | "down") => {
        if (!authStatus) {
            setLoginModal(true)
            return
        }
        setIsPulsating(voteType)
        axios.post(`/api/zpage/${page.free2zaddr}/vote/`, { vote: voteType })
            .then(response => {
                setScore(response.data.f2z_score);
                setTimeout(() => setIsPulsating(false), 500);
            })
            .catch(res => {
                setIsPulsating(false)
                let errorMessage = "Problem with backend, please try again";
                // If the response exists and it's a client error
                if (res && res.status >= 400 && res.status < 500) {
                    errorMessage = res.data.error;
                }
                setSnack({
                    message: errorMessage,
                    duration: null,
                    severity: "error",
                    open: true,
                })
            });
    };

    // when we change pages, need to force rerender ;/
    useEffect(() => {
        setScore(page.f2z_score)
    }, [page.f2z_score])

    return (
        <Stack
            direction="row"
            alignItems="center"
            justifyContent="center"
            spacing={1}
        >
            <IconButton onClick={() => handleVote("up")}
                disabled={isPulsating !== false}
            >
                <ThumbUp
                    fontSize="small"
                    sx={{
                        "&:hover, &:active": {
                            transform: "scale(1.13)",
                            transition: "transform 0.21s ease-in-out",
                            color: theme.palette.success.main,
                        },
                        animation: isPulsating === "up" ?
                            "explodeup 0.5s" : "none",
                    }}
                />
            </IconButton>
            <Typography>{parseInt(score)}</Typography>
            <IconButton onClick={() => handleVote("down")}
                disabled={isPulsating !== false}
            >
                <ThumbDown
                    fontSize="small"
                    sx={{
                        "&:hover, &:active": {
                            transform: "scale(1.13)",
                            transition: "transform 0.21s ease-in-out",
                            color: theme.palette.warning.main,
                        },
                        animation: isPulsating === "down" ?
                            "explodedown 0.5s" : "none",
                    }}
                />
            </IconButton>
        </Stack>
    );
}
