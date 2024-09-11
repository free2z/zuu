import { Close, Preview } from "@mui/icons-material";
import {
    FormControl, Stack, TextField, Button, Paper, Box,
    IconButton, Tooltip, Backdrop, Typography, useTheme,
} from "@mui/material"
import axios from "axios";
import { useState } from "react";
import { useGlobalState } from "../state/global"
import F2ZMarkdownField from "./F2ZMarkdownField";
import LoginMessageStack from "./LoginMessageStack"
import TuziIcon from "./TuziIcon";
import MathMarkdown from "./MathMarkdown";
import { useQueryClient } from "react-query";
import TuzisMenuItem from "./TuzisMenuItem";
import TuzisButton from "./TuzisButton";


type Props = {
    // TODO: all of these lean on zpage ;/
    // zpage?: PageInterface,
    object_type?: "zpage" | "ai_conversation",
    object_uuid?: string,
    parent?: string,
    callback?: () => void,
    height?: number,
}

export default function CommentForm(props: Props) {
    const { callback, object_type, object_uuid, parent } = props
    const [creator, _] = useGlobalState("creator")
    const [snackbar, setSnackbar] = useGlobalState("snackbar")
    const [preview, setPreview] = useState(false)
    const [submitting, setSubmitting] = useState(false)
    const queryClient = useQueryClient()
    const theme = useTheme();

    const oc = {
        headline: "",
        content: "",
        tuzis: 1,
    }
    const [formData, setFormData] = useState(oc)

    const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value } = event.target
        setFormData({ ...formData, [name]: value })
    }


    const handleSubmit = () => {
        let url
        if (object_type && object_uuid) {
            url = `/api/comments/${object_type}/${object_uuid}/`
        } else if (parent) {
            url = `/api/comments/${parent}/replies/`
        } else {
            url = `/api/comments/`
        }
        // console.log("SUBMITTING", url, formData)
        setSubmitting(true)
        axios
            .post(
                url,
                { ...formData, parent: parent },
            )
            .then((res) => {
                // console.log(res)
                setFormData(oc)
                setPreview(false)
                setSubmitting(false)
                callback && callback()
                queryClient.invalidateQueries(["comments"])
            })
            .catch((err) => {
                setSubmitting(false)
                setSnackbar({
                    message: JSON.stringify(err.data),
                    severity: "error",
                    open: true,
                    duration: undefined,
                })
            })
    }

    return (
        <Box component="div"
            style={{
                position: 'relative', // Needed for overlay positioning
                marginBottom: "1em",
                padding: "0.5em 0",
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
            }}
        >
            {!creator.username &&
                <LoginMessageStack
                    message="Log in to make a comment with 2Zs!"
                />
            }
            {!!creator.username &&
                <FormControl
                    onSubmit={handleSubmit}
                    style={{
                        width: "100%",
                        // maxWidth: "600px",
                        margin: "0 auto",
                    }}
                // disabled={!creator.tuzis}
                >
                    <Stack
                        spacing={1}
                    >
                        <TextField
                            id="headline"
                            label="Headline"
                            name="headline"
                            variant="outlined"
                            // variant="filled"
                            value={formData.headline}
                            onChange={handleInputChange}
                            required
                            fullWidth
                            error={formData.headline.length > 100}
                        />
                        <Paper
                            sx={{
                                border: formData.content.length >= 1000 ?
                                    (theme) => `2px solid ${theme.palette.error.main}`
                                    : undefined,
                                // padding: (theme) => theme.spacing(2),
                            }}
                        >
                            <F2ZMarkdownField
                                content={formData.content}
                                cb={(content) => {
                                    setFormData({
                                        ...formData,
                                        content: content || "",
                                    })
                                }}
                                height={props.height || 350}
                            />
                        </Paper>

                        <Stack direction="row" spacing={2}
                            sx={{
                                paddingTop: "0.5em",
                            }}
                        >
                            <Tooltip title="Toggle Preview">
                                <IconButton
                                    onClick={() => {
                                        setPreview(!preview);
                                    }}
                                    size="small"
                                >
                                    {preview ?
                                        <Close color="warning" fontSize="small" />
                                        :
                                        <Preview color="info" fontSize="small" />
                                    }
                                </IconButton>
                            </Tooltip>

                            <TextField
                                id="tuzis"
                                label="Weight"
                                name="tuzis"
                                variant="outlined"
                                size="small"
                                // variant="standard"
                                type="number"
                                value={formData.tuzis}
                                onChange={(e) => {
                                    setFormData({
                                        ...formData,
                                        tuzis: parseInt(e.target.value),
                                    });
                                }}
                                required
                                error={formData.tuzis < 1}
                                InputProps={{
                                    endAdornment: <TuziIcon />,
                                }}
                            // sx={{
                            //     maxWidth: '150px',
                            // }}
                            />

                            <Button
                                variant="contained"
                                type="submit"
                                onClick={handleSubmit}
                                color="success"
                                disabled={
                                    !(
                                        formData.content.length > 0 &&
                                        formData.content.length <= 1000 &&
                                        formData.headline.length > 0 &&
                                        formData.headline.length <= 100 &&
                                        formData.tuzis >= 1
                                    ) || submitting
                                }
                                fullWidth
                            >
                                Post
                            </Button>
                        </Stack>
                        {preview &&
                            <Box component="div"
                                style={{
                                    minHeight: "200px",
                                }}
                            >
                                <MathMarkdown content={formData.content} />
                            </Box>
                        }
                    </Stack>
                </FormControl>
            }
            {Number(creator.tuzis) <= 0 && creator.username &&
                <div
                    style={{
                        position: 'absolute',
                        top: -5,
                        left: -5,
                        right: -5,
                        bottom: -5,
                        backgroundColor: theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.7)' : 'rgba(0, 0, 0, 0.7)',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 2,
                    }}
                >
                    <Typography
                        variant="h4"
                        component="div"
                        sx={{
                            // color: theme.palette.mode === 'dark' ?  : "white",
                            color: theme.palette.primary.contrastText,
                            textAlign: 'center',
                            marginBottom: '23px',
                            fontWeight: 'bold',
                        }}
                    >
                        You can't comment without 2Zs.
                    </Typography>
                    <Paper style={{
                        padding: "0.72em 1em 1em 1em",

                        backgroundColor: theme.palette.mode === 'dark' ? 'rgba(0, 0, 0, 0.88)' : 'rgba(255, 255, 255, 0.88)',
                        // opacity: 0.88,
                    }}>
                        <TuzisButton {...creator} />
                    </Paper>
                </div>
            }

        </Box >
    )
}