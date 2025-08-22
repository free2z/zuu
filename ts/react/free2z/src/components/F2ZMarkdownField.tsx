import { FolderOpen, Satellite, SatelliteAlt, Upload, YouTube } from "@mui/icons-material";
import MDEditor, { ICommand, TextAreaTextApi, TextState } from "@uiw/react-md-editor"
import axios from "axios";
import { useEffect, useRef, useState } from "react";
import { samplePage } from "../Constants"
import { useGlobalState } from "../state/global";
import { useStoreState } from "../state/persist";
import LinearProgressBackdrop from "./LinearProgressBackdrop";
import { noCommands } from "./MarkdownEditor"
import "./F2ZMarkdownField.css"
import AIzPageDialog from "./AIzPageDialog";
import DallezPageDialog from "./DallezPageDialog";
import FileSelectorDialog from "./FileSelectorDialog";
import { FileMetadata } from "./DragDropFiles";
import { Box, Typography } from "@mui/material";
import LoadingAnimation from "./LoadingAnimation";
import { maxBytesForTuzis, humanBytes, getMessage } from "../lib/size-limits";
import { max } from "moment";

const embed: ICommand = {
    name: 'embed',
    keyCommand: 'embed',
    shortcuts: 'ctrlcmd+e',
    value: '::embed[]',
    buttonProps: {
        'aria-label': 'Add embed (ctrl + e)',
        title: 'Add embed (ctrl + e)'
    },
    icon: (<YouTube />),
    execute(state, api) {
        const imageTemplate = state.selectedText || 'url';
        api.replaceSelection(`\n\n::embed[${imageTemplate}]\n\n`);
        api.setSelectionRange({
            start: 10 + state.selection.start,
            end: 10 + state.selection.start + imageTemplate.length
        });
    }
};

type Props = {
    content: string,
    cb: (content: string | undefined) => void,
    height?: string | number
    placeholder?: string
    required?: boolean
    title?: string
    previewWindow?: Window
    handleSave?: () => any
}

export default function F2ZMarkdownField(props: Props) {
    const { content, cb, height, placeholder, title } = props
    const setSnackbarState = useGlobalState("snackbar")[1]
    const [creator] = useGlobalState("creator")
    const darkMode = useStoreState("darkmode")
    const [prog, setProgress] = useState(0)
    const inputRef = useRef<HTMLInputElement>(null);
    const [aiOpen, setAIOpen] = useState(false)
    const [aiState, setAIstate] = useState({} as TextState)
    const [aiTA, setAITA] = useState({} as TextAreaTextApi)

    const [dalleOpen, setDalleOpen] = useState(false)
    const [dalleState, setDalleState] = useState({} as TextState)
    const [dalleTA, setDalleTA] = useState({} as TextAreaTextApi)

    const [imageSelectorOpen, setImageSelectorOpen] = useState(false);
    const [editorApi, setEditorApi] = useState<null | TextAreaTextApi>(null);
    const [uploadState, setUploadState] = useState<'idle' | 'uploading' | 'processing'>('idle')

    const editorRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!props.previewWindow || !editorRef.current) return;
        const textArea = editorRef.current.querySelector('textarea');
        if (!(textArea instanceof HTMLTextAreaElement)) return;

        const handleScroll = () => {
            const { scrollTop, scrollHeight, clientHeight } = textArea;
            if (scrollHeight - scrollTop - clientHeight < 100) {
                props.previewWindow?.scrollTo({
                    top: props.previewWindow?.document.body.scrollHeight,
                    behavior: 'smooth'
                });
            }
        };
        textArea.addEventListener('scroll', handleScroll);
        return () => textArea.removeEventListener('scroll', handleScroll);
    }, [editorRef.current, props.previewWindow]);

    useEffect(() => {
        const handleSaveShortcut = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                props.handleSave && props.handleSave();
            }
        };
        document.addEventListener('keydown', handleSaveShortcut, { passive: false });
        return () => document.removeEventListener('keydown', handleSaveShortcut);
    }, [props.handleSave]);

    const handleImageSelection = (file: FileMetadata) => {
        setImageSelectorOpen(false);
        const title = (file.description || file.title || file.name).replace(/\n/g, "");
        let insert = "";
        if (file.mime_type?.startsWith("image")) {
            insert = `![${title}](${file.url})`;
        } else if (file.mime_type?.startsWith("video")) {
            insert = `::embed[${file.url}]`;
        } else if (file.mime_type?.startsWith("audio")) {
            insert = `::embed[${file.url}]`;
        } else {
            insert = `[${title}](${file.url})`;
        }
        editorApi && editorApi.replaceSelection(`\n\n${insert}\n\n`);
    }

    const handleUpload = (
        event: React.ChangeEvent<HTMLInputElement>,
        api: TextAreaTextApi,
    ) => {
        const file = event.target.files?.[0];
        if (!file) {
            setProgress(0);
            return;
        }

        // Client-side guard so we never start sending bytes if too big.
        const maxBytes = maxBytesForTuzis(creator?.tuzis);

        if (file.size > maxBytes) {
            setSnackbarState({
                message: `“${file.name}” is too large. Max ${humanBytes(maxBytes)}. ${getMessage(maxBytes)}`,
                open: true,
                duration: undefined,
                severity: 'error',
            });
            return;
        }

        setProgress(1);
        setUploadState('uploading');

        const formData = new FormData();
        formData.append("file", file);

        axios({
            method: "POST",
            url: "/uploads/single-public",
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
            onDownloadProgress: () => setUploadState('idle'),
            headers: { "Content-Type": "multipart/form-data" },
            data: formData
        })
            .then(resp => {
                const { mime_type, url, thumbnail } = resp.data;
                if (mime_type.startsWith('video') || mime_type.startsWith('audio')) {
                    api.replaceSelection(`\n::embed[${url}]\n\n`);
                } else if (mime_type.startsWith('image')) {
                    api.replaceSelection(`\n\n![](${thumbnail || url})\n\n`);
                } else {
                    api.replaceSelection(`[The File](${url})`);
                }
                setProgress(0);
            })
            .catch(error => {
                setSnackbarState({
                    message: `upload failed${error?.response?.status ? ` (${error.response.status})` : ""}`,
                    open: true,
                    duration: undefined,
                    severity: 'error',
                });
                setProgress(0);
                setUploadState('idle');
            });
    };

    const fileUpload: ICommand = {
        name: 'fileUpload',
        keyCommand: 'fileUpload',
        shortcuts: 'ctrlcmd+u',
        value: '',
        buttonProps: {
            'aria-label': 'Upload file (ctrl + u)',
            title: 'Upload file (ctrl + u)'
        },
        icon: (
            <>
                <Upload />
                <input type="file" style={{ display: 'none' }} ref={inputRef} />
            </>
        ),
        execute(state, api) {
            if (!inputRef?.current) return;
            inputRef.current.onchange = function () {
                const event = { target: inputRef.current } as React.ChangeEvent<HTMLInputElement>;
                handleUpload(event, api);
            };
            inputRef.current.click();
        },
    };

    const openai: ICommand = {
        name: 'AI',
        keyCommand: 'AI',
        shortcuts: 'ctrlcmd+a',
        value: '',
        buttonProps: {
            'aria-label': ' (ctrl + a)',
            title: 'AI (ctrl + a)'
        },
        icon: (<SatelliteAlt />),
        execute(state, api) {
            setAIstate(state)
            setAITA(api)
            setAIOpen(true)
        },
    }

    const selectFile: ICommand = {
        name: 'selectFile',
        keyCommand: 'selectFile',
        shortcuts: 'ctrlcmd+shift+p',
        value: '',
        buttonProps: {
            'aria-label': ' (ctrl + shift + p)',
            title: 'Select File (ctrl + shift + p)'
        },
        icon: (<FolderOpen />),
        execute(state, api) {
            setImageSelectorOpen(true)
            setEditorApi(api)
        }
    }

    const dalle: ICommand = {
        name: 'Dall-E',
        keyCommand: 'Dall-E',
        shortcuts: 'ctrlcmd+m',
        value: '',
        buttonProps: {
            'aria-label': ' (ctrl + m)',
            title: 'AI (ctrl + m)'
        },
        icon: (<Satellite />),
        execute(state, api) {
            setDalleState(state)
            setDalleTA(api)
            setDalleOpen(true)
        },
    }

    return (
        <div data-color-mode={darkMode ? "dark" : "light"}>
            <LinearProgressBackdrop progress={prog} />
            {uploadState === 'processing' && (
                <Box component="div" sx={{
                    position: 'fixed',
                    top: 0, bottom: 0, left: 0, right: 0,
                    zIndex: 1300,
                    backgroundColor: 'rgba(0,0,0,0.7)',
                    color: 'white',
                    p: '1rem',
                    justifyContent: "center",
                    display: 'flex',
                    alignItems: 'center'
                }}>
                    <LoadingAnimation />
                    <div
                        style={{
                            textAlign: 'center',
                            color: 'text',
                            opacity: 0.1,
                            fontSize: '2.25em',
                            textShadow: '1px 1px 1px #fff, -1px -1px 1px #fff, 1px -1px 1px #fff',
                            animation: 'zanyMove 3s linear infinite, shimmer 2s ease-in-out infinite',
                            position: 'absolute',
                        }}
                    >
                        <Typography variant="body1" sx={{ mt: 2 }}>
                            Processing files on server...
                        </Typography>
                        <Typography variant="body1" sx={{ mt: 1 }}>
                            This may take a few moments
                        </Typography>
                    </div>
                </Box>
            )}

            <AIzPageDialog state={aiState} ta={aiTA} open={aiOpen} setOpen={setAIOpen} title={title} />
            <DallezPageDialog state={dalleState} ta={dalleTA} open={dalleOpen} setOpen={setDalleOpen} title={title} />
            <FileSelectorDialog open={imageSelectorOpen} onClose={() => setImageSelectorOpen(false)} onSelect={handleImageSelection} />

            <div ref={editorRef}>
                <MDEditor
                    style={{ border: `1px solid gray` }}
                    value={content}
                    onChange={cb}
                    textareaProps={{ placeholder: placeholder || samplePage }}
                    enableScroll
                    highlightEnable={false}
                    visibleDragbar={false}
                    height={height || 555}
                    preview={"edit"}
                    extraCommands={[dalle, openai, embed, fileUpload, selectFile]}
                    commandsFilter={(command: ICommand) => {
                        if (noCommands.includes(command.name || "")) return false
                        return command
                    }}
                />
            </div>
        </div>
    )
}
