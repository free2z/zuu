import { ClosedCaption, HighlightOff } from "@mui/icons-material";
import { FormControl, IconButton, InputAdornment, MenuItem, Select, TextField } from "@mui/material";
import { FileMetadata } from "./DragDropFiles";

type FileUploadFormProps = {
    // file: File,
    list: File[],
    setList: React.Dispatch<React.SetStateAction<File[]>>,
    metadata: FileMetadata[],
    setMetadata: React.Dispatch<React.SetStateAction<FileMetadata[]>>,
    index: number,
}


export default function FileUploadForm(props: FileUploadFormProps) {
    const { list, setList, metadata, setMetadata, index } = props

    if (!metadata[index]) {
        return null
    }

    const { title, name } = metadata[index];
    const hasError = title.length > 128 || name.length > 128;

    return (
        // <Stack>
        <FormControl
            sx={{
                margin: "1em",
                padding: "1em",
                borderWidth: "2px",
                borderRadius: "1rem",
                borderStyle: "dashed",
                borderColor: hasError ? "error.main" : "#cbd5e1",
                alignContent: "center",
                justifyContent: "center",
                alignItems: "center",
            }}
        >
            {/* <InputLabel id="select-label">Access</InputLabel> */}
            <Select
                fullWidth
                // labelId="select-label"
                id="demo-simple-select"
                value={metadata[index].access}
                // label="Access"
                onChange={(e) => {
                    const datum = metadata[index]
                    const newd = {
                        ...datum,
                        access: e.target.value as "private" | "members" | "public",
                    }
                    const newarr = [...metadata]
                    newarr[index] = newd
                    setMetadata(newarr)
                    // setDatum(newd)
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
                fullWidth
                variant="standard"
                value={metadata[index].title}
                error={hasError}
                helperText={
                    hasError ?
                        "Please use a shorter filename"
                        : metadata[index].name
                }
                // TODO: keyboard access?
                // onKeyDown={(v) => {
                //     if (v.keyCode === 13) {
                //         handleSubmit()
                //     }
                // }}
                onChange={(e) => {
                    const datum = metadata[index]
                    const newd = {
                        ...datum,
                        title: e.target.value,
                    }
                    const newarr = [...metadata]
                    newarr[index] = newd
                    setMetadata(newarr)
                }}
                InputProps={{
                    endAdornment: (
                        <InputAdornment position="start">
                            <ClosedCaption color="primary" />
                        </InputAdornment>
                    ),
                }}
            />
            <IconButton
                size="small"
                style={{
                    maxWidth: "50px",
                }}
                onClick={() => {
                    setList([
                        ...list.filter((item, i) => {
                            return i !== index
                        })
                    ])
                    setMetadata([
                        ...metadata.filter((item, i) => {
                            return i !== index
                        })
                    ])
                }}
            >
                <HighlightOff />
            </IconButton>
        </FormControl>
    )
}
