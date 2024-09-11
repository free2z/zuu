import axios from 'axios';
import { ThumbUp, ThumbDown } from "@mui/icons-material";
import { IconButton, Stack, Typography, useTheme } from "@mui/material";
import { CommentData } from "./DisplayThreadedComments";
import { useState } from 'react';
import { useGlobalState } from '../state/global';

import './UpDownPage.css'

type Props = {
    comment: CommentData,
    // setReload: React.Dispatch<React.SetStateAction<number>>
}

export default function CommentVote(props: Props) {
    const { comment } = props
    const [extra, setExtra] = useState(0)
    const [creator, _] = useGlobalState("creator")
    const [snack, setSnack] = useGlobalState("snackbar")
    const [authStatus, _2] = useGlobalState("authStatus")
    const [loginModal, setLoginModal] = useGlobalState("loginModal")
    const [isPulsating, setIsPulsating] = useState(false as "up" | "down" | false)
    const theme = useTheme()

    const handleVote = (voteType: "up" | "down") => {
        if (!authStatus) {
            setLoginModal(true)
            return
        }
        setIsPulsating(voteType)

        axios.post(`/api/comments/${comment.uuid}/vote/`, { vote: voteType })
            .then(response => {
                // console.log(response);
                // setReload(Math.random())
                if (voteType === "up") {
                    setExtra(extra + 1)
                } else {
                    setExtra(extra - 1)
                }
                setTimeout(() => setIsPulsating(false), 500);
            })
            .catch(res => {
                console.error(res);
                setIsPulsating(false)

                let errorMessage = "Problem with backend, please try again";
                // If the response exists and it's a client error
                if (res && res.status >= 400 && res.status < 500) {
                    errorMessage = res.data.error;
                }

                setSnack({
                    message: errorMessage,
                    duration: undefined,
                    severity: "error",
                    open: true,
                })
            });
    }

    return (
        <Stack direction="row"
            alignItems={"center"}
        >
            <IconButton onClick={() => handleVote('up')}
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
            <Typography>{comment.tuzis + extra}</Typography>
            <IconButton onClick={() => handleVote('down')}
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
    )
}
