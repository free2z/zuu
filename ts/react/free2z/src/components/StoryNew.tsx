import { useState } from "react";
import { Paper, Typography, TextField, Button, InputAdornment } from "@mui/material";
import axios from "axios";
import { AutoStories } from "@mui/icons-material";
import { useGlobalState } from "../state/global";
import { useTransitionNavigate } from "../hooks/useTransitionNavigate";


export default function StoryNew() {
    const [title, setTitle] = useState('');
    const navigate = useTransitionNavigate()
    const [snackbar, setSnackbarState] = useGlobalState("snackbar")

    return (
        <Paper
            style={{
                width: "100%",
                padding: "1em",
                // margin: "1em",
            }}
        >
            <Typography>Create a new story</Typography>
            <TextField
                fullWidth
                label="Title"
                value={title}
                onChange={(ev) => { setTitle(ev.target.value) }}
                margin="normal"
                // helperText="Create a new story"
                InputProps={{
                    endAdornment: (
                        <InputAdornment position="start">
                            <AutoStories color="secondary" />
                        </InputAdornment>
                    ),
                }}
            />
            <Button
                variant="outlined"
                color="success"
                onClick={() => {
                    // console.log(title)
                    axios.post("/api/storytime/start", {
                        title: title,
                    }).then((res) => {
                        navigate(`/storytime/edit/${res.data.creator.username}/${res.data.slug}`)
                    }).catch((res) => {
                        setSnackbarState({
                            message: JSON.stringify(res.data),
                            open: true,
                            duration: undefined,
                            severity: "error",
                        })
                    })
                }}
            >
                Start
            </Button>
        </Paper>
    );
}
