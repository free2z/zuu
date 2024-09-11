import { Delete } from "@mui/icons-material"
import { Dialog, DialogContent, TextField, Button, DialogActions, InputAdornment, IconButton, useMediaQuery, Theme } from "@mui/material"
import { TextState, TextAreaTextApi } from "@uiw/react-md-editor"
import axios from "axios"
import { useEffect, useState } from "react"
import { useGlobalState } from "../state/global"

// const truncatedPrompt = prompt.length > maxLength ? prompt.substring(0, maxLength - 3) + "..." : prompt;
function truncate(str: string, n: number) {
    return (str.length > n) ? `${str.substring(0, n - 3)}...` : str;
}


type Props = {
    state?: TextState
    ta?: TextAreaTextApi
    title?: string
    open: boolean
    setOpen: React.Dispatch<React.SetStateAction<boolean>>
}

export default function DallezPageDialog(props: Props) {
    const { state, ta, open, setOpen, title } = props
    const [prompt, setPrompt] = useState("");
    // const [responseText, setResponseText] = useState("")
    const [loading, setLoading] = useGlobalState("loading")
    const [snackbar, setSnackbar] = useGlobalState("snackbar")

    const isXS = useMediaQuery((theme: Theme) => theme.breakpoints.down('sm'));

    useEffect(() => {
        if (!state) return
        // if (!ta) return
        let textToUse = "";
        if (state.selectedText !== "") {
            textToUse = state.selectedText;
        } else {
            const words = state.text.substring(0, state.selection.start).split(/\s+/);
            const startIndex = Math.max(0, words.length - 20);
            textToUse = words.slice(startIndex).join(" ");
        }
        // console.log(textToUse)
        setPrompt(textToUse)
    }, [state])

    const handleSubmit = () => {
        if (!ta) return
        setLoading(true)

        axios.post('/api/openai/image', {
            prompt: prompt,
            // size: '512x512'
        })
            .then(res => {
                // console.log(res.data);
                ta.replaceSelection(`![${truncate(prompt.replace(/\n/g, ' '), 4000)}](${res.data})`)
                handleClose()
                setLoading(false)
            })
            .catch(res => {
                handleClose()
                setLoading(false)
                setSnackbar({
                    message: "Something went wrong with the AI Provider? Try again later!",
                    severity: "error",
                    open: true,
                    duration: null,
                })
            });
    }
    const handleClose = () => {
        setOpen(false)
    }

    if (!state || !ta) {
        return null
    }

    return (
        <Dialog
            open={open}
            onClose={() => setOpen(false)}
            fullWidth={true}
            maxWidth={"sm"}
            fullScreen={isXS}
        >
            <DialogContent>
                <TextField
                    autoFocus
                    fullWidth
                    label="Prompt"
                    multiline
                    minRows={4}
                    maxRows={15}
                    variant="outlined"
                    value={prompt}
                    onChange={e => setPrompt(e.target.value)}
                    helperText={"Generate an AI image with the prompt for 5 2Zs"}
                    InputProps={{
                        endAdornment: (prompt && (
                            <InputAdornment position="start">
                                <IconButton
                                    onClick={() => setPrompt("")}>
                                    <Delete />
                                </IconButton>
                            </InputAdornment>
                        )),
                    }}
                />
            </DialogContent>
            <DialogActions>
                <Button
                    color="warning"
                    onClick={handleClose}
                >Close</Button>
                <Button onClick={handleSubmit}>Get AI Image</Button>
            </DialogActions>
        </Dialog>
    )
}
