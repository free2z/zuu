import { Grid, Typography } from '@mui/material';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useGlobalState } from '../state/global';
import RedirectUnauthed from './RedirectUnauthed';
import StoryAddPage from './StoryAddPage';
import StoryPages from './StoryPages';
import { SimpleCreator } from './MySubscribers';


export interface StoryPage {
    prompt: string
    image_url: string
    content: string
    order: number
    created_at: string
    updated_at: string
}


export interface Story {
    creator: SimpleCreator
    title: string
    slug: string
    created_at: string
    updated_at: string
    pages: StoryPage[]
}


export default function StoryTimeEdit() {
    const { creator, slug } = useParams()
    const [story, setStory] = useState({} as Story)
    const [current, _] = useGlobalState("creator")
    const [loading, setLoading] = useGlobalState("loading")
    const [snackbar, setSnackbarState] = useGlobalState("snackbar")

    const resetStory = () => {
        if (!current.username) {
            return
        }
        setLoading(true)
        axios.get(
            `/api/storytime/mystories/${slug}`
        ).then((res) => {
            // console.log(res)
            setStory(res.data)
        }).catch((res) => {
            console.error("ERROR", res)
            setSnackbarState({
                message: JSON.stringify(res.data),
                open: true,
                duration: undefined,
                severity: "error",
            })
        }).finally(() => {
            setLoading(false)
        })
    }

    useEffect(resetStory, [current.username])

    if (!current.username) {
        return null
    }
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
            <RedirectUnauthed />
            <Typography
                variant="h2"
                style={{
                    width: "100%",
                    marginBottom: "0.25em",
                }}
            >{story.title}</Typography>
            <StoryPages story={story} />
            <StoryAddPage
                story={story}
                resetStory={resetStory}
            />
        </Grid>
    )
}
