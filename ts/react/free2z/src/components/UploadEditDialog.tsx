import { ClosedCaption } from "@mui/icons-material"
import {
    Dialog, DialogTitle, DialogContent, FormControl,
    InputAdornment, MenuItem, Select, TextField, Button,
    DialogActions, useMediaQuery, Theme,
} from "@mui/material"
import axios from "axios"
import Cookies from "js-cookie"
import { useEffect, useState } from "react"
import { FileMetadata } from "./DragDropFiles"
import UploadDeleteButton from "./UploadDeleteButton"

type UploadEditDialogProps = {
    open: boolean,
    setOpen: React.Dispatch<React.SetStateAction<boolean>>,
    file: FileMetadata,
    setLoads: React.Dispatch<React.SetStateAction<number>>,
}

export default function UploadEditDialog(props: UploadEditDialogProps) {
    const { open, setOpen, file, setLoads } = props

    const [vals, setVals] = useState({} as FileMetadata)
    const isXS = useMediaQuery((theme: Theme) => theme.breakpoints.down("sm"))

    useEffect(() => {
        setVals(file)
    }, [file])

    const handleUpdate = () => {
        const csrf = Cookies.get("csrftoken")
        const headers = {
            "X-CSRFToken": csrf || "",
        }
        axios.patch(`/api/myuploads/${file.id}/`, {
            ...vals,
            // ...changed,
        }, {
            headers: headers,
        }).then((res) => {
            setLoads(Math.random())
            setOpen(false)
        }).catch((res) => {
            console.error("XATCH", res)
        })
    }


    return (
        <Dialog
            onClose={() => { props.setOpen(false) }} open={open}
            fullScreen={isXS}
            maxWidth="md"
            fullWidth
        >
            <DialogTitle>Set Permissions and Data</DialogTitle>
            <DialogContent>
                <FormControl
                    style={{
                        width: "100%",
                    }}
                >
                    <Select
                        fullWidth
                        id="demo-simple-select"
                        value={vals.access}
                        onChange={(e) => {
                            setVals({
                                ...vals,
                                access: e.target.value as "private" | "members" | "public",
                            })
                        }}
                    >
                        <MenuItem value={"private"}>Private</MenuItem>
                        <MenuItem value={"members"}>Members Only</MenuItem>
                        <MenuItem value={"public"}>Public</MenuItem>
                    </Select>
                    <TextField
                        // autoFocus={true}
                        margin="normal"
                        color="secondary"
                        id="title"
                        label="title"
                        type="text"
                        // Link?
                        helperText={vals.name}
                        // fullWidth
                        variant="standard"
                        value={vals.title}
                        onChange={(e) => {
                            setVals({
                                ...vals,
                                title: e.target.value,
                            })
                        }}
                        InputProps={{
                            endAdornment: (
                                <InputAdornment position="start">
                                    <ClosedCaption color="primary" />
                                </InputAdornment>
                            ),
                        }}
                        FormHelperTextProps={{
                            style: {
                                whiteSpace: 'normal',
                                wordWrap: 'break-word',
                            },
                        }}
                    />
                </FormControl>
            </DialogContent>
            <DialogActions>
                <UploadDeleteButton
                    uploadId={file.id || 0}
                    finish={() => {
                        setOpen(false)
                        setLoads(Math.random())
                    }}
                />
                <Button
                    fullWidth
                    color="primary"
                    onClick={() => { setOpen(false) }}
                >Close</Button>
                <Button
                    fullWidth
                    variant="contained"
                    color="primary"
                    onClick={handleUpdate}
                >Update</Button>
            </DialogActions>
        </Dialog>
    )
}