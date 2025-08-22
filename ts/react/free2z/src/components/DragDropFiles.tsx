// https://www.codemzy.com/blog/react-drag-drop-file-upload
import {
    Button, Chip, Divider, InputLabel, Paper, Stack, Typography,
    CircularProgress, Box
} from "@mui/material";
import axios from "axios";
import Cookies from "js-cookie";
import { useState, useRef, ChangeEvent, DragEvent } from "react";
import { useGlobalState } from "../state/global";
import FileUploadForm from "./FileUploadForm";
import LinearProgressBackdrop from "./LinearProgressBackdrop";
import MyUploads from "./MyUploads";
import LoadingAnimation from "./LoadingAnimation";
import { maxBytesForTuzis, humanBytes, getMessage } from "../lib/size-limits";

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
    const [snack, setSnack] = useGlobalState("snackbar");
    const [loads, setLoads] = useState(0);
    const [dragActive, setDragActive] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const [fileList, setFileList] = useState([] as File[]);
    const [metadata, setMetadata] = useState([] as FileMetadata[]);
    const [prog, setProgress] = useState(0);
    const [uploadState, setUploadState] = useState<'idle' | 'uploading' | 'processing'>('idle');
    const [creator] = useGlobalState("creator");

    // handle drag events
    const handleDrag = (e: DragEvent<HTMLElement>) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.type === "dragenter" || e.type === "dragover") setDragActive(true);
        else if (e.type === "dragleave") setDragActive(false);
    };

    // triggers when file is dropped
    const handleDrop = (e: DragEvent<HTMLElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setDragActive(false);
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            const files = Array.from(e.dataTransfer.files || []);
            const meta = files.map((file) => ({
                access: 'private',
                title: file.name,
                name: file.name,
            } as FileMetadata));
            setFileList(prev => [...prev, ...files]);
            setMetadata(prev => [...prev, ...meta]);
        }
    };

    // triggers when file is selected with click
    const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
        e.preventDefault();
        const files = Array.from((e.target as HTMLInputElement).files || []);
        if (files && files[0]) {
            setFileList(prev => [...prev, ...files]);
            setMetadata(prev => [
                ...prev,
                ...files.map((file) => ({
                    access: 'private',
                    title: file.name,
                    name: file.name,
                } as FileMetadata))
            ]);
        }
    };

    // triggers the input when the button is clicked
    const onButtonClick = () => inputRef.current?.click();

    const uploadClick = async () => {
        const tuzis = Number.parseInt(String(creator?.tuzis ?? "0"), 10) || 0;
        const maxBytes = maxBytesForTuzis(tuzis);

        // prevent oversize upload from even starting
        const tooBig = fileList.find(f => f.size > maxBytes);
        if (tooBig) {
            setSnack({
                message: `Max ${humanBytes(maxBytes)}. ${getMessage(maxBytes)}`,
                open: true,
                duration: undefined,
                severity: 'error',
            });
            return;
        }

        setProgress(1);
        setUploadState('uploading');

        const formData = new FormData();
        fileList.forEach(file => formData.append("files", file));
        formData.append("body", JSON.stringify(metadata));
        const csrf = Cookies.get("csrftoken") || "";

        axios({
            method: "POST",
            url: "/uploads/handle",
            data: formData,
            headers: {
                "Content-Type": "multipart/form-data",
                "X-CSRFToken": csrf,
            },
            onUploadProgress: (progressEvent) => {
                const loaded = progressEvent.loaded ?? 0;
                const total = progressEvent.total ?? 0;
                if (total > 0) {
                    const pct = (loaded / total) * 100;
                    if (loaded === total) {
                        setProgress(0);
                        setUploadState('processing');
                    } else {
                        setProgress(pct);
                    }
                }
            },
            onDownloadProgress: () => {
                setUploadState('idle');
            },
        }).then(() => {
            setMetadata([]);
            setFileList([]);
            setProgress(0);
            setUploadState('idle');
            setLoads(l => l + 1);
            setSnack({
                open: true,
                severity: "success",
                message: "Files uploaded successfully",
                duration: 5000,
            });
        }).catch((err) => {
            setProgress(0);
            setUploadState('idle');
            const status = err?.response?.status;
            const msg = status ? `Upload failed (${status}).` : "Upload failed.";
            setSnack({
                open: true,
                severity: "error",
                message: msg,
                duration: undefined,
            });
            setLoads(l => l + 1);
        });
    };

    const tuzis = Number.parseInt(String(creator?.tuzis ?? "0"), 10) || 0;
    const maxForUser = humanBytes(maxBytesForTuzis(tuzis));

    return (
        <>
            <LinearProgressBackdrop progress={prog} />
            {uploadState === 'processing' && (
                <Box component="div" sx={{
                    position: 'fixed',
                    top: 0, left: 0, right: 0,
                    width: "100%", height: "100%",
                    zIndex: 1300,
                    backgroundColor: 'rgba(0,0,0,0.7)',
                    color: 'white', p: '1rem',
                    display: 'flex', alignItems: 'center', justifyContent: 'center'
                }}>
                    <LoadingAnimation />
                    <div style={{
                        textAlign: 'center',
                        color: 'text',
                        opacity: 0.1,
                        fontSize: '2.25em',
                        textShadow: '1px 1px 1px #fff, -1px -1px 1px #fff, -1px 1px 1px #fff, 1px -1px 1px #fff',
                        animation: 'zanyMove 3s linear infinite, shimmer 2s ease-in-out infinite',
                        position: 'absolute',
                    }}>
                        <Typography variant="h4" sx={{ mt: 2 }}>
                            Processing files on server...
                        </Typography>
                        <Typography variant="h4" sx={{ mt: 1 }}>
                            This may take a few moments
                        </Typography>
                    </div>
                </Box>
            )}

            <Paper sx={{ backgroundColor: dragActive ? "text.secondary" : "background.paper", p: "1em 0" }}>
                <form
                    id="form-file-upload"
                    onDragEnter={handleDrag}
                    onSubmit={(e) => e.preventDefault()}
                    style={{
                        minHeight: "16rem", height: "100%", width: "100%", maxWidth: "100%",
                        textAlign: "center", position: "relative",
                    }}
                >
                    <input
                        ref={inputRef}
                        type="file"
                        id="input-file-upload"
                        multiple
                        onChange={handleChange}
                        style={{ display: "none" }}
                    />
                    <InputLabel
                        htmlFor="input-file-upload"
                        style={{
                            minHeight: "16rem", height: "100%",
                            display: "flex", alignItems: "center", justifyContent: "center",
                        }}
                    >
                        <Stack direction="column">
                            <Typography>Drag and drop your files here or</Typography>
                            <Button color="primary" variant="contained" onClick={onButtonClick}>
                                Select Files
                            </Button>
                            <Typography variant="caption">
                                You can upload files up to {maxForUser} in size.
                            </Typography>
                        </Stack>
                    </InputLabel>

                    {dragActive && (
                        <div
                            id="drag-file-element"
                            onDragEnter={handleDrag}
                            onDragLeave={handleDrag}
                            onDragOver={handleDrag}
                            onDrop={handleDrop}
                            style={{
                                position: "absolute", width: "100%", height: "100%", borderRadius: "1rem",
                                top: 0, right: 0, bottom: 0, left: 0, zIndex: 10000,
                            }}
                        />
                    )}

                    {!!metadata.length && (
                        <Divider>
                            <Chip label="Edit Permissions and Metadata" color="secondary" />
                        </Divider>
                    )}

                    {!!metadata.length && metadata.map((_, i) => (
                        <FileUploadForm
                            key={i}
                            list={fileList}
                            setList={setFileList}
                            metadata={metadata}
                            setMetadata={setMetadata}
                            index={i}
                        />
                    ))}

                    {!!fileList.length && (
                        <Stack direction="column" style={{ margin: "1em" }}>
                            <Button
                                variant="outlined"
                                onClick={uploadClick}
                                disabled={
                                    uploadState !== 'idle' ||
                                    metadata.some(file => file.name.length > 100 || file.title.length > 64)
                                }
                                startIcon={uploadState !== 'idle' ? <CircularProgress size={20} /> : null}
                            >
                                {uploadState === 'idle' ? 'Upload' :
                                    uploadState === 'uploading' ? 'Uploading...' : 'Processing...'}
                            </Button>
                        </Stack>
                    )}
                </form>
            </Paper>

            <MyUploads loads={loads} setLoads={setLoads} />
        </>
    );
}
