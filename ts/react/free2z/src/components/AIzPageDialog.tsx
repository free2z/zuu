import { Delete } from "@mui/icons-material"
import {
    Dialog, DialogContent, TextField, Button, DialogActions,
    InputAdornment, IconButton, useMediaQuery,
} from "@mui/material"
import { TextState, TextAreaTextApi } from "@uiw/react-md-editor"
import axios from "axios"
import { useEffect, useState } from "react"
import { useGlobalState } from "../state/global"

type Props = {
    state?: TextState
    ta?: TextAreaTextApi
    title?: string
    open: boolean
    setOpen: React.Dispatch<React.SetStateAction<boolean>>
}

export default function AIzPageDialog(props: Props) {
    const { state, ta, open, setOpen, title } = props
    const [prompt, setPrompt] = useState("");
    const [loading, setLoading] = useGlobalState("loading")
    const [snackbar, setSnackbar] = useGlobalState("snackbar")
    const isXS = useMediaQuery('(max-width:399px)');

    useEffect(() => {
        if (!state) return
        // if (!ta) return
        let textToUse = "";
        if (state.selectedText !== "") {
            textToUse = state.selectedText;
        } else {
            const words = state.text.substring(0, state.selection.start).split(/\s+/);
            const startIndex = Math.max(0, words.length - 100);
            textToUse = words.slice(startIndex).join(" ");
        }
        setPrompt(textToUse)
    }, [state])

    const handleSubmit = () => {
        if (!ta) return
        setLoading(true)
        // TODO: title? pretrain to different use cases? hrm ...
        // how to parameterize?
        axios.post('/api/openai/prompt', { prompt: prompt })
            .then(res => {
                // Just add for now
                // TODO: maybe give choices or keep chatting ..
                // setResponseText(res.data.choices[0].text)
                // console.log(res)
                ta.replaceSelection(res.data)
                handleClose()
                setLoading(false)
            })
            .catch(res => {
                console.error(res);
                setLoading(false)
                setSnackbar({
                    message: "AI Provider might be down? Try again later!",
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
            maxWidth={"md"}
            fullScreen={isXS}
        >
            <DialogContent>
                <TextField
                    autoFocus
                    fullWidth
                    label="Prompt"
                    multiline
                    minRows={3}
                    maxRows={18}
                    variant="outlined"
                    value={prompt}
                    onChange={e => setPrompt(e.target.value)}
                    helperText={"Get AI completion for 1 2Z"}
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
                <Button onClick={handleSubmit}>Get AI Text</Button>
            </DialogActions>
        </Dialog>
    )
}
