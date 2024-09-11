import { Image, Public, Publish, PublishOutlined, TextIncrease } from "@mui/icons-material"
import { TextField, Button, Stack, IconButton, Grid, Tooltip, Paper } from "@mui/material"
import axios from "axios"
import { useState } from "react"
import { useGlobalState } from "../state/global"
import { Story } from "./StoryTimeEdit"
import { useTransitionNavigate } from "../hooks/useTransitionNavigate"


type Props = {
    story: Story
    resetStory: () => void
}

export default function StoryAddPage(props: Props) {
    const { story, resetStory } = props
    const [prompt, setPrompt] = useState("")
    const [loading, setLoading] = useGlobalState("loading")
    const [snackbar, setSnackbarState] = useGlobalState("snackbar")
    const navigate = useTransitionNavigate()

    function addContent(type: string) {
        setLoading(true)
        const url = `/api/storytime/${story.slug}/${type}`;
        axios.post(url, { prompt })
            .then(res => {
                // console.log(res);
                resetStory()
            })
            .catch(res => {
                console.error("ERROR", res)
                setLoading(false)
                setSnackbarState({
                    message: JSON.stringify(res.data),
                    open: true,
                    duration: undefined,
                    severity: "error",
                })
            });
    }

    function publish() {
        axios.patch(`/api/storytime/mystories/${story.slug}`, {
            is_published: true,
        }).then((res) => {
            navigate(`/storytime/${story.creator.username}/${story.slug}`)
        })
    }

    return (
        <Grid container
            style={{
                width: "100%",
            }}
            alignItems="center"
            justifyContent="center"
            textAlign="left"
        >
            <Paper
                style={{
                    marginTop: "1em",
                    width: "100%",
                    padding: "1.5em 0.5em 0.5em 0.5em",
                }}
                elevation={20}
            >
                <Grid item xs={12}>
                    <TextField
                        id="prompt"
                        label="Prompt"
                        variant="outlined"
                        // helperText=""
                        value={prompt}
                        fullWidth
                        onChange={(ev) => {
                            setPrompt(ev.target.value)
                        }}
                        multiline
                        minRows={1}
                        maxRows={5}
                    />
                </Grid>
                <Grid item xs={12}>
                    <Stack
                        direction="row"
                        alignItems="center"
                        justifyContent="center"
                        spacing={1}
                    >
                        <Tooltip title="Add Image">
                            <IconButton
                                color="primary"
                                onClick={() => {
                                    addContent("image")
                                }}
                            >
                                <Image />
                            </IconButton>
                        </Tooltip>
                        <Tooltip title="Add Text">
                            <IconButton
                                color="primary"
                                onClick={() => {
                                    addContent("text")
                                }}
                            >
                                <TextIncrease />
                            </IconButton>
                        </Tooltip>
                        {story.pages && story.pages.length > 1 && (
                            <Tooltip title="Publish">
                                <IconButton
                                    color="primary"
                                    onClick={() => {
                                        publish()
                                    }}
                                >
                                    <PublishOutlined
                                        color="warning"
                                    />
                                </IconButton>
                            </Tooltip>
                        )}

                    </Stack>
                </Grid>
            </Paper>
        </Grid>
    )
}
