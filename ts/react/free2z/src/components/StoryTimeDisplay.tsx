import { Grid, Typography } from '@mui/material';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useGlobalState } from '../state/global';
import StoryPages from './StoryPages';
import { Story } from './StoryTimeEdit';



export default function StoryTimeDisplay() {
    const { creator, slug } = useParams()
    const [story, setStory] = useState({} as Story)
    const [loading, setLoading] = useGlobalState("loading")
    const [snackbar, setSnackbarState] = useGlobalState("snackbar")

    const resetStory = () => {
        setLoading(true)
        axios.get(
            `/api/storytime/${creator}/${slug}`
        ).then((res) => {
            // console.log(res)
            setStory(res.data)
        }).catch((res) => {
            setSnackbarState({
                message: JSON.stringify(res.data),
                open: true,
                duration: undefined,
                severity: "error",
            })
        })
        .finally(() => {
            setLoading(false)
        })
    }

    useEffect(resetStory, [])

    if (!story.title) {
        return null
    }
    return (
        <Grid
            style={{
                minHeight: "100vh",
                width: "100%",
            }}
        >
            <Typography
                variant="h2"
                style={{
                    width: "100%",
                    marginBottom: "0.25em",
                }}
            >{story.title}</Typography>
            <StoryPages story={story} />
        </Grid>
    )
}
