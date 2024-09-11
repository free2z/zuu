// https://www.codemzy.com/blog/react-drag-drop-file-upload
import {
    Button, Chip, Divider, InputLabel, Paper, Stack, Typography
} from "@mui/material";
import axios from "axios";
import Cookies from "js-cookie";
import { useState, useRef, ChangeEvent, DragEvent } from "react";
import { useGlobalState } from "../state/global";
import FileUploadForm from "./FileUploadForm";
import LinearProgressBackdrop from "./LinearProgressBackdrop";
import MyUploads from "./MyUploads";


export type FileMetadata = {
    name: string,
    title: string,
    access: "private" | "members" | "public",
    mime_type?: string,
    id?: number,
    url?: string,
    description?: string,
    thumbnail?: string,
}

export default function DragDropFile() {
    const [snack, setSnack] = useGlobalState("snackbar")
    // const [loading, setLoading] = useGlobalState('loading')
    const [loads, setLoads] = useState(0)
    const [dragActive, setDragActive] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const [fileList, setFileList] = useState([] as File[])
    const [metadata, setMetadata] = useState([] as FileMetadata[])
    const [prog, setProgress] = useState(0)

    // handle drag events
    const handleDrag = function (e: DragEvent<HTMLElement>) {
        // console.log("DRAG", e)
        e.preventDefault();
        e.stopPropagation();
        if (e.type === "dragenter" || e.type === "dragover") {
            setDragActive(true);
        } else if (e.type === "dragleave") {
            setDragActive(false);
        }
    };

    // triggers when file is dropped
    const handleDrop = function (e: DragEvent<HTMLElement>) {
        // console.log("DROP", e)
        e.preventDefault();
        e.stopPropagation();
        setDragActive(false);
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            // handleFiles(e.dataTransfer.files);
            // console.log("WE HAVE FILES", e.dataTransfer.files)

            const files = Array.from(e.dataTransfer.files || [])
            // console.log(files)
            const meta = files.map((file) => {
                return {
                    access: 'private',
                    title: file.name,
                    name: file.name,
                } as FileMetadata
            })
            // console.log("META", meta)
            setFileList([
                ...fileList,
                ...files,
            ])
            setMetadata([
                ...metadata,
                ...meta,
            ])
        }
    };

    // triggers when file is selected with click
    const handleChange = function (e: ChangeEvent<HTMLInputElement>) {
        // console.log("CHANGE", e)
        e.preventDefault();

        const files = Array.from((e.target as HTMLInputElement).files || [])

        if (files && files[0]) {
            setFileList([
                ...fileList,
                ...files,
            ])
            setMetadata([
                ...metadata,
                ...files.map((file) => {
                    return {
                        access: 'private',
                        title: file.name,
                        name: file.name,
                    } as FileMetadata
                })
            ])
        }
    };

    // triggers the input when the button is clicked
    const onButtonClick = () => {
        if (!inputRef.current) {
            return
        }
        inputRef.current.click();
    };

    const uploadClick = () => {
        // https://stackoverflow.com/q/71989915/177293
        // https://stackoverflow.com/a/42096508/177293
        // https://stackoverflow.com/a/61221416/177293
        // TODO: better loading
        // setLoading(true)
        // console.log("UPLOAD")
        // console.log(fileList)
        // console.log(metadata)
        setProgress(1)

        // create formData object
        const formData = new FormData();
        fileList.forEach(file => {
            formData.append("files", file);
        });

        formData.append("body", JSON.stringify(metadata))
        const csrf = Cookies.get("csrftoken")
        // console.log(formData)
        axios({
            method: "POST",
            url: "/uploads/handle",
            data: formData,
            headers: {
                "Content-Type": "multipart/form-data",
                "X-CSRFToken": csrf || "",
            },
            onUploadProgress: (progressEvent) => {
                const progress = (progressEvent.loaded / progressEvent.total) * 100;
                setProgress(progress)
            },
        }).then((res) => {
            setMetadata([])
            setFileList([])
            // setLoading(false)
            setProgress(0)
            setLoads(loads + 1)
        }).catch((res) => {
            // console.log(res)
            setProgress(0)
            setSnack({
                open: true,
                severity: "error",
                message: JSON.stringify(res.data),
                duration: undefined,
            })
            setLoads(loads + 1)
        })
    }

    return (
        <>
            <LinearProgressBackdrop progress={prog} />
            <Paper
                sx={{
                    backgroundColor: dragActive ? "text.secondary" : "background.paper",
                    padding: "1em 0",
                }}
            >
                <form
                    id="form-file-upload"
                    onDragEnter={handleDrag}
                    onSubmit={(e) => e.preventDefault()}
                    style={{
                        minHeight: "16rem",
                        height: "100%",
                        width: "100%",
                        maxWidth: "100%",
                        textAlign: "center",
                        position: "relative",
                    }}
                >
                    <input
                        ref={inputRef}
                        type="file"
                        id="input-file-upload"
                        multiple={true}
                        onChange={handleChange}
                        style={{ display: "none" }}
                    />
                    <InputLabel
                        htmlFor="input-file-upload"
                        style={{
                            minHeight: "16rem",
                            height: "100%",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            // borderWidth: "2px",
                            // borderRadius: "1rem",
                            // borderStyle: "dashed",
                            // borderColor: "#cbd5e1",
                            // backgroundColor: dragActive ? "#fff" : "#f8fafc",

                        }}
                    >
                        <Stack direction="column">
                            <Typography>Drag and drop your files here or</Typography>
                            <Button
                                color="primary"
                                variant="contained"
                                onClick={onButtonClick}
                            >
                                Select Files
                            </Button>
                            <Typography variant="caption">
                                Maximum 250MB per upload
                            </Typography>
                        </Stack>
                    </InputLabel>
                    {dragActive &&
                        <div id="drag-file-element"
                            onDragEnter={handleDrag}
                            onDragLeave={handleDrag}
                            onDragOver={handleDrag}
                            onDrop={handleDrop}
                            style={{
                                position: "absolute",
                                width: "100%",
                                height: "100%",
                                borderRadius: "1rem",
                                top: "0px",
                                right: "0px",
                                bottom: "0px",
                                left: "0px",
                                zIndex: 10000,
                            }}
                        >
                        </div>
                    }

                    {!!metadata.length &&
                        <Divider>
                            <Chip
                                label="Edit Permissions and Metadata"
                                color="secondary"
                            />
                        </Divider>
                    }

                    {!!metadata.length && metadata.map((_, i) => {
                        return <FileUploadForm
                            key={i}
                            // file={file}
                            list={fileList}
                            setList={setFileList}
                            metadata={metadata}
                            setMetadata={setMetadata}
                            index={i}
                        />
                    })}


                    {!!fileList.length &&
                        <Stack
                            direction="column"
                            // spacing={10}
                            style={{
                                margin: "1em",
                            }}
                        >
                            <Button
                                variant="outlined"
                                onClick={uploadClick}
                                disabled={
                                    metadata.some(
                                        file => file.name.length > 100 || file.title.length > 64
                                    )
                                }
                            >Upload</Button>
                        </Stack>
                    }
                </form>
            </Paper>
            {/* When loads changes it makes a query */}
            <MyUploads loads={loads} setLoads={setLoads} />
        </>
    );
};
