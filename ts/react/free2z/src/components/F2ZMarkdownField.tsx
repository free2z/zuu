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

const embed: ICommand = {
    name: 'embed',
    keyCommand: 'embed',
    shortcuts: 'ctrlcmd+e',
    value: '::embed[]',
    buttonProps: {
        'aria-label': 'Add embed (ctrl + e)',
        title: 'Add embed (ctrl + e)'
    },
    icon: (
        <YouTube />
    ),
    execute: function execute(state, api) {
        var imageTemplate = state.selectedText || 'url';
        api.replaceSelection("\n\n::embed[".concat(imageTemplate, "]\n\n"));
        // Adjust the selection to not contain the **
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
    // the axiosresponse coupling is no better than plain any
    handleSave?: () => any
}


export default function F2ZMarkdownField(props: Props) {
    const { content, cb, height, placeholder, required, title } = props
    const setSnackbarState = useGlobalState("snackbar")[1]
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

    const editorRef = useRef<HTMLDivElement | null>(null); // Ref to the MDEditor container

    // This just scrolls our preview window if it is open
    // and we are near the bottom of the editor.
    useEffect(() => {
        if (!props.previewWindow) {
            return;
        }

        if (!editorRef.current) {
            console.log('Editor ref is not attached yet.');
            return;
        }

        // Access the textarea inside the MDEditor
        const textArea = editorRef.current.querySelector('textarea');
        if (!(textArea instanceof HTMLTextAreaElement)) {
            console.log('Textarea not found within MDEditor.');
            return;
        }

        const handleScroll = () => {
            const { scrollTop, scrollHeight, clientHeight } = textArea;
            // console.log(`Scroll Top: ${scrollTop}, Scroll Height: ${scrollHeight}, Client Height: ${clientHeight}`);

            // Check if we are near the bottom
            if (scrollHeight - scrollTop - clientHeight < 100) {
                props.previewWindow?.scrollTo({
                    top: props.previewWindow?.document.body.scrollHeight,
                    behavior: 'smooth'
                });
            }
        };

        // console.log('Attaching scroll event listener to the textarea.');
        // Attach the scroll event
        textArea.addEventListener('scroll', handleScroll);

        // Cleanup
        return () => {
            // console.log('Removing scroll event listener from the textarea.');
            textArea.removeEventListener('scroll', handleScroll);
        };
    }, [editorRef.current, props.previewWindow]); // Depend on editorRef


    useEffect(() => {
        const handleSaveShortcut = (e: KeyboardEvent) => {
            // Check for ctrlKey (Windows/Linux) or metaKey (macOS)
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                console.log("ctrl/cmd + s detected");
                e.preventDefault(); // Prevent the default save action
                props.handleSave && props.handleSave();
            }
        };

        // Attach the event listener
        document.addEventListener('keydown', handleSaveShortcut, { passive: false });

        // Clean up the event listener
        return () => {
            document.removeEventListener('keydown', handleSaveShortcut);
        };
    }, [props.handleSave]);

    const handleImageSelection = (file: FileMetadata) => {
        // You can add the markdown insertion logic here
        // Close the dialog
        setImageSelectorOpen(false);
        let insert = ""
        let title = (file.description || file.title || file.name).replace(/\n/g, "");

        if (file.mime_type?.startsWith("image")) {
            // Add image to the editor
            insert = `![${title}](${file.url})`;
        } else if (file.mime_type?.startsWith("video")) {
            insert = `::embed[${file.url}]`
        } else if (file.mime_type?.startsWith("audio")) {
            insert = `::embed[${file.url}]`
        } else {
            insert = `[${title}](${file.url})`
        }
        // console.log("CALLING", editorApi)
        editorApi && editorApi.replaceSelection(`\n\n${insert}\n\n`);
    }

    const handleUpload = (
        event: React.ChangeEvent<HTMLInputElement>,
        api: TextAreaTextApi,
    ) => {
        setProgress(1)
        // event.preventDefault();
        const file = event.target.files?.[0];
        if (!file) {
            setProgress(0)
            console.error("no file!")
            return;
        }

        const formData = new FormData();
        formData.append("file", file);
        // You could add metadata in the formData here if you need it
        axios({
            method: "POST",
            url: "/uploads/single-public",
            onUploadProgress: (progressEvent) => {
                const progress = (progressEvent.loaded / progressEvent.total) * 100;
                setProgress(progress)
            },
            headers: {
                "Content-Type": "multipart/form-data"
            },
            data: formData
        })
            .then(resp => {
                // Set the URL of the uploaded file to the text field
                // cb(response)
                if (
                    resp.data.mime_type.startsWith('video') ||
                    resp.data.mime_type.startsWith('audio')
                ) {
                    api.replaceSelection(
                        `\n::embed[${resp.data.url}]\n\n`
                    );
                } else if (resp.data.mime_type.startsWith('image')) {
                    api.replaceSelection(
                        `\n\n![](${resp.data.thumbnail || resp.data.url})\n\n`
                    )
                } else {
                    api.replaceSelection(
                        `[The File](${resp.data.url})`
                    )
                }
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
                <input
                    type="file"
                    style={{ display: 'none' }}
                    ref={inputRef}
                />
            </>
        ),
        execute: function execute(state, api) {
            if (!inputRef || !inputRef.current) return
            inputRef.current.onchange = function () {
                const event = {
                    target: inputRef.current
                } as React.ChangeEvent<HTMLInputElement>
                handleUpload(
                    event,
                    api
                );
            }
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
        icon: (
            <>
                <SatelliteAlt />
            </>
        ),
        execute: function execute(state, api) {
            // console.log(state, api)
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
        icon: (
            <>
                <FolderOpen />
            </>
        ),
        execute: function execute(state, api) {
            setImageSelectorOpen(true)
            // console.log("SET", editorApi, api)
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
        icon: (
            <>
                <Satellite />
            </>
        ),
        execute: function execute(state, api) {
            setDalleState(state)
            setDalleTA(api)
            setDalleOpen(true)
        },
    }

    return (
        <div data-color-mode={darkMode ? "dark" : "light"}>
            <LinearProgressBackdrop progress={prog} />
            <AIzPageDialog
                state={aiState}
                ta={aiTA}
                open={aiOpen}
                setOpen={setAIOpen}
                title={title}
            />
            <DallezPageDialog
                state={dalleState}
                ta={dalleTA}
                open={dalleOpen}
                setOpen={setDalleOpen}
                title={title}
            />
            <FileSelectorDialog
                open={imageSelectorOpen}
                onClose={() => setImageSelectorOpen(false)}
                onSelect={handleImageSelection}
            />
            <div ref={editorRef}>
                <MDEditor
                    style={{
                        border: `1px solid gray`,
                    }}
                    value={content}
                    onChange={cb}
                    // This doesn't override the default browser save page
                    // call handleSave on cmd+s, ctrl+s
                    // onKeyUp={(e) => {
                    //     if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                    //         console.log("ctrl+s")
                    //         e.preventDefault();
                    //         props.handleSave && props.handleSave();
                    //     }
                    // }}
                    textareaProps={{
                        placeholder: placeholder || samplePage,
                        // ref: textAreaRef,
                    }}
                    enableScroll={true}
                    highlightEnable={false}
                    visibleDragbar={false}
                    height={height || 555}
                    preview={"edit"}
                    extraCommands={[dalle, openai, embed, fileUpload, selectFile]}
                    commandsFilter={(
                        command: ICommand,
                        isExtra: boolean
                    ): false | ICommand => {
                        // console.log(command, isExtra)
                        if (noCommands.includes(command.name || "")) {
                            return false
                        }
                        return command
                    }}
                />
            </div>
        </div>
    )
}