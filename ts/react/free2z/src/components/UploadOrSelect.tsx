import React, { ChangeEvent, useEffect, useState } from "react";
import axios, { AxiosResponse } from "axios";
import {
    Button, IconButton, Tooltip, Box, Dialog, DialogTitle, DialogContent,
    DialogActions, ImageList, ImageListItem, Stack, Typography, Link,
} from "@mui/material";
import { Upload, PhotoLibrary, Clear } from "@mui/icons-material";
import { useGlobalState } from "../state/global";
import MyUploadsSearch from "./MyUploadsSearch";
import { FileMetadata } from "./DragDropFiles";
import LinearProgressBackdrop from "./LinearProgressBackdrop";
import LightboxImage from "./CustomImage";
import { FeaturedImage } from "./PageRenderer";
import LoadingAnimation from "./LoadingAnimation";


type UploadOrSelectProps = {
    spacing?: number,
    noPreview?: boolean,
    cb?: (image: FileMetadata | null) => void,
    selectedImage: FileMetadata | null,
    setSelectedImage: React.Dispatch<React.SetStateAction<FileMetadata | null>>
}

export default function UploadOrSelect(props: UploadOrSelectProps) {
    const { selectedImage, setSelectedImage, noPreview, spacing, cb } = props
    const setSnackbarState = useGlobalState("snackbar")[1]
    const [results, setResults] = useState([] as FeaturedImage[])
    const [openDialog, setOpenDialog] = useState(false);
    const [prog, setProgress] = useState(0)
    const [mql, setMQL] = useState(window.matchMedia('(max-width: 600px)'))
    const [searching, setSearching] = useState(true)
    const [uploadState, setUploadState] = useState<'idle' | 'uploading' | 'processing'>('idle')

    const handleUpload = (
        event: ChangeEvent<HTMLInputElement>,
        cb: (resp: AxiosResponse<any, any>) => void
    ) => {
        setProgress(1)
        event.preventDefault();
        const file = event.target.files?.[0];
        if (!file) return;
        const formData = new FormData();
        formData.append("file", file);
        // You could add metadata in the formData here if you need it
        axios({
            method: "POST",
            url: "/uploads/single-public",
            onUploadProgress: (progressEvent) => {
                const loaded = progressEvent.loaded
                const total = progressEvent.total
                const progress = (loaded / total) * 100;
                if (loaded === total) {
                    setProgress(0)
                    setUploadState('processing')
                }
                else {
                    setProgress(progress)
                }
            },
            onDownloadProgress: () => {
                setUploadState('idle')
            },
            headers: {
                "Content-Type": "multipart/form-data"
            },
            data: formData
        })
            .then(response => {
                // Set the URL of the uploaded file to the text field
                cb(response)
                setProgress(0)
            })
            .catch(error => {
                setSnackbarState({
                    message: `upload failed ${error}`,
                    open: true,
                    duration: undefined,
                    severity: 'error',
                })
                setProgress(0)
            });
    };

    const handleSelect = (image: FileMetadata) => {
        // TODO: set it on the page/creator - take callback ...
        // Set selectedImage state and close the dialog
        // console.log("HANDLE SELECT", image)
        setSelectedImage(image);
        cb && cb(image);
        setOpenDialog(false);
    };

    const openImageSelectionDialog = () => {
        setOpenDialog(true);
    };

    useEffect(() => {
        window.addEventListener('resize', () => {
            setMQL(window.matchMedia('(max-width: 600px)'));
        })
    }, [])

    return (
        <>
            <LinearProgressBackdrop progress={prog} />
            {uploadState === 'processing' && (
                <Box component="div" sx={{
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    right: 0,
                    width: "100%",
                    height: "100%",
                    zIndex: 1300,
                    backgroundColor: 'rgba(0,0,0,0.7)',
                    color: 'white',
                    padding: '1rem',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                }}>
                    <LoadingAnimation />
                    <div
                        style={{
                            textAlign: 'center',
                            color: 'text',
                            opacity: 0.1,
                            fontSize: '2.25em',
                            textShadow: '1px 1px 1px #fff, -1px -1px 1px #fff, -1px 1px 1px #fff, 1px -1px 1px #fff',
                            animation: 'zanyMove 3s linear infinite, shimmer 2s ease-in-out infinite',
                            position: 'absolute',
                        }}
                    >
                        <Typography variant="body1" sx={{ mt: 2 }}>
                            Processing files on server...
                        </Typography>
                        <Typography variant="caption" sx={{ mt: 1 }}>
                            This may take a few moments
                        </Typography>
                    </div>
                </Box>
            )}

            <Stack direction="column"
                alignItems="center"
                style={{
                    width: "100%",
                }}
            >
                <Stack
                    direction="row"
                    spacing={spacing !== undefined ? spacing : 2}>
                    <Tooltip title="Upload Image">
                        <IconButton color="primary" component="label">
                            <Upload />
                            <input
                                type="file"
                                style={{ display: "none" }}
                                onChange={(ev) => {
                                    handleUpload(ev, (response) => {
                                        // console.log("UPLOAD SUCCESS", response)
                                        // TODO: set the page/creator data
                                        // with callback
                                        setSelectedImage(response.data)
                                        cb && cb(response.data)
                                    })
                                }}
                            />
                        </IconButton>
                    </Tooltip>
                    <Tooltip title="Select Image">
                        <IconButton
                            color="info"
                            onClick={openImageSelectionDialog}
                        >
                            <PhotoLibrary />
                        </IconButton>
                    </Tooltip>
                    {/* TODO: generate */}
                    {selectedImage && (
                        <Tooltip title="Remove">
                            <IconButton
                                color="warning"
                                onClick={() => {
                                    setSelectedImage(null)
                                    cb && cb(null)
                                }}
                            >
                                <Clear />
                            </IconButton>
                        </Tooltip>
                    )}
                </Stack>
                {selectedImage && !noPreview && (
                    <Box
                        component="div"
                        display="inline-flex"
                        alignItems="center" marginLeft={1}
                        style={{
                            maxWidth: "355px",
                            maxHeight: "211px",
                            // height: "auto",
                            overflow: "auto",
                        }}
                    >
                        <LightboxImage
                            src={selectedImage.url}
                            alt={selectedImage.title}
                            hideCaption={true}
                        />
                    </Box>
                )}
            </Stack>

            <Dialog
                open={openDialog} onClose={() => setOpenDialog(false)}
                maxWidth="md"
                fullWidth={!mql.matches}
                fullScreen={mql.matches}
            >
                <DialogTitle>
                    <MyUploadsSearch
                        setSearching={setSearching}
                        setResults={setResults}
                        extraQuery={"access=public&mime_type=image"}
                    />
                </DialogTitle>
                <DialogContent>
                    {results.length === 0 && !searching && (
                        <Typography>
                            No uploads!
                            Try <Link href="/profile/uploads">uploading</Link> some images.
                        </Typography>
                    )}
                    <ImageList cols={mql.matches ? 2 : 3} gap={8}
                        sx={{
                            minHeight: "50vh",
                        }}
                    >
                        {results.map((image) => (
                            <ImageListItem key={image.id}>
                                <img
                                    src={image.thumbnail}
                                    alt={image.title}
                                    style={{ cursor: "pointer" }}
                                    onClick={() => handleSelect(image)}
                                />
                            </ImageListItem>
                        ))}
                    </ImageList>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setOpenDialog(false)} color="info">
                        Close
                    </Button>
                </DialogActions>
            </Dialog>
        </>
    );
}
