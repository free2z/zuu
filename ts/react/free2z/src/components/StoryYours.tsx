import { Card, CardContent, CardMedia, Link, List, ListItem, ListItemText, Typography } from "@mui/material";
import axios from "axios";
import { useEffect, useState } from "react";
import { useGlobalState } from "../state/global";
import StoryRow from "./StoryRow";
import { Story } from "./StoryTimeEdit";

export default function StoryYours() {
    const [stories, setStories] = useState([] as Story[])
    const [current, _] = useGlobalState("creator")
    const [snackbar, setSnackbarState] = useGlobalState("snackbar")

    useEffect(() => {
        axios.get('/api/storytime/mystories/').then((res) => {
            // console.log(res.data)
            setStories(res.data.results)
        }).catch((res) => {
            console.error("ERROR getting stories", res)
            setSnackbarState({
                message: JSON.stringify(res.data),
                open: true,
                duration: undefined,
                severity: "error",
            })
        })
    }, [])

    return (
        <>
            {
                stories.map((story: Story) => {
                    return <StoryRow story={story} />
                })
            }
        </>
    )
}
