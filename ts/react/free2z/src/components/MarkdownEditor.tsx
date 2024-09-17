import { useEffect, useState, useRef } from "react";
import SwipeableViews from "react-swipeable-views";
import { ThemeProvider, useTheme } from "@mui/material/styles";
import Tabs from "@mui/material/Tabs";
import Tab from "@mui/material/Tab";
import Box from "@mui/material/Box";
import { PageInterface } from "./PageRenderer";
import MathMarkdown from "./MathMarkdown";
import { CssBaseline, Divider, Grid, IconButton, Paper, Stack, Tooltip } from "@mui/material";
import { Fullscreen, FullscreenExit, HelpCenter, OpenInNew } from "@mui/icons-material";
import { AxiosResponse } from "axios";
import F2ZMarkdownField from "./F2ZMarkdownField";
import { TabPanel } from "./TabPanel";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { CacheProvider, Theme } from '@emotion/react';
import createCache from '@emotion/cache';

export const noCommands = [
    "comment",
    "strikethrough",
    "checked-list",
    "edit",
    "live",
    "preview",
    "fullscreen",
];

interface MarkdownEditorProps {
    page: PageInterface;
    setPage: React.Dispatch<React.SetStateAction<PageInterface>>;
    handleSave: () => Promise<AxiosResponse<any, any>>;
}

function PreviewWindow({
    content, container, theme,
}: {
    content: string, container: HTMLElement, theme: Theme,
}) {
    // Create an Emotion cache for the new window
    const cache = createCache({
        key: 'mui', // You can change this to a unique key to avoid conflicts
        container, // This specifies the container where styles are inserted
        prepend: true, // Ensures styles are inserted at the top
    });

    return (
        <BrowserRouter>
            <CacheProvider value={cache}>
                <ThemeProvider theme={theme}>
                    <CssBaseline />
                    <Box component="div"
                        sx={{
                            margin: 1,
                            marginBottom: 15,
                            paddingBottom: 15,
                        }}
                    >
                        <MathMarkdown content={content} />
                    </Box>
                </ThemeProvider>
            </CacheProvider>
        </BrowserRouter>
    );
}


export default function MarkdownEditor(props: MarkdownEditorProps) {
    const { page, setPage, handleSave } = props;
    const theme = useTheme();
    const [value, setValue] = useState(0);
    const [isFullScreen, setIsFullScreen] = useState(false);
    const [previewWindow, setPreviewWindow] = useState<Window | null>(null);
    const previewRootRef = useRef<ReactDOM.Root | null>(null); // Use a ref to track the React root

    useEffect(() => {
        document.body.style.overflow = isFullScreen ? "hidden" : "auto";
        return () => {
            document.body.style.overflow = "auto";
        };
    }, [isFullScreen]);

    useEffect(() => {
        if (previewWindow && !previewWindow.closed) {
            if (previewRootRef.current) {
                try {
                    const container = previewWindow.document.head; // Ensure styles are inserted into the head
                    previewRootRef.current.render(
                        <PreviewWindow
                            content={page.content} container={container}
                            theme={theme}
                        />
                    );
                } catch (e) {
                    console.error("Error rendering preview window", e);
                }
            }
        }
    }, [page.content]);

    const handleOpenPreviewWindow = () => {
        if (!previewWindow || previewWindow.closed) {
            console.log("Opening new preview window...");
            const width = 800;
            const height = 800;
            const left = window.screen.width - width;
            const top = 0;

            const newWindow = window.open("", "MarkdownPreview", `width=${width},height=${height},left=${left},top=${top}`);

            if (newWindow) {
                setPreviewWindow(newWindow);

                newWindow.document.title = "zPage Preview";

                // Insert the viewport meta tag into the head
                const metaViewport = newWindow.document.createElement('meta');
                metaViewport.name = "viewport";
                metaViewport.content = "width=device-width, initial-scale=1";
                newWindow.document.head.appendChild(metaViewport);

                // Copy styles from the parent window to the new window
                const styles = document.querySelectorAll("style, link[rel='stylesheet']");
                styles.forEach((style) => {
                    newWindow.document.head.appendChild(style.cloneNode(true));
                });

                // Create a new root for the preview window
                const rootElement = newWindow.document.createElement("div");
                newWindow.document.body.appendChild(rootElement);
                const root = ReactDOM.createRoot(rootElement);
                previewRootRef.current = root;

                try {
                    const container = newWindow.document.head; // Ensure styles are inserted into the head
                    root.render(
                        <PreviewWindow
                            content={page.content} container={container}
                            theme={theme}
                        />
                    );
                    console.log("Preview window opened and rendered successfully.");
                } catch (e) {
                    console.error("Error rendering preview window on open", e);
                }

                newWindow.onbeforeunload = () => {
                    console.warn("Preview window was closed.");
                    if (previewRootRef.current) {
                        previewRootRef.current.unmount();
                    }
                    setPreviewWindow(null);
                };
            } else {
                console.error("Failed to open preview window.");
            }
        } else {
            console.log("Preview window already open, bringing it to focus.");
            previewWindow.focus();
        }
    };

    const handleFullScreenToggle = () => {
        setIsFullScreen(!isFullScreen);
    };

    const handleChange = (event: React.SyntheticEvent, newValue: number) => {
        setValue(newValue);
    };

    const handleChangeIndex = (index: number) => {
        setValue(index);
    };

    return (
        <Grid
            item
            xs={12}
            style={
                isFullScreen
                    ? {
                        position: "fixed",
                        top: 0,
                        left: 0,
                        bottom: 0,
                        right: 0,
                        zIndex: 1299,
                        background: "white",
                        height: "100vh",
                        width: "100%",
                        overflow: "auto",
                    }
                    : {}
            }
        >
            <Paper elevation={2}>
                <Box
                    component="div"
                    sx={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                    }}
                >
                    <Tabs
                        value={value}
                        onChange={handleChange}
                        indicatorColor="secondary"
                        textColor="inherit"
                    >
                        <Tab label="Edit" onClick={handleSave} />
                        <Tab label="Preview" onClick={handleSave} />
                    </Tabs>
                    <Stack direction="row"
                        spacing={{
                            xs: 0, sm: 1,
                        }}
                        style={{ marginRight: "0.5em" }}
                    >
                        <Tooltip title="Learn Free2Z-Flavored Markdown">
                            <IconButton
                                onClick={() => {
                                    const win = window.open(
                                        "https://free2z.cash/flavored-markdown",
                                        "_blank"
                                    );
                                    win?.focus();
                                }}
                            >
                                <HelpCenter />
                            </IconButton>
                        </Tooltip>
                        <Tooltip title="Pop out Preview">
                            <IconButton onClick={handleOpenPreviewWindow}>
                                <OpenInNew />
                            </IconButton>
                        </Tooltip>
                        <Tooltip title="Toggle Fullscreen">
                            <IconButton onClick={handleFullScreenToggle}>
                                {isFullScreen ? <FullscreenExit /> : <Fullscreen />}
                            </IconButton>
                        </Tooltip>
                    </Stack>
                </Box>
                <SwipeableViews
                    axis={theme.direction === "rtl" ? "x-reverse" : "x"}
                    index={value}
                    onChangeIndex={handleChangeIndex}
                    style={{ minHeight: "555px", width: "100%" }}
                >
                    <TabPanel value={value} index={0}>
                        <F2ZMarkdownField
                            content={page.content}
                            cb={(v) => {
                                setPage({ ...page, content: v || "" });
                            }}
                            required={true}
                            title={page.title}
                            height={isFullScreen ? "calc(100vh - 54px)" : "555px"}
                            previewWindow={previewWindow || undefined}
                            handleSave={handleSave}
                        />
                    </TabPanel>
                    <TabPanel value={value} index={1}>
                        <Box
                            component="div"
                            style={{
                                minHeight: "555px",
                                textAlign: "left",
                                padding: "0 1em 1em 1em",
                            }}
                        >
                            <Divider />
                            <MathMarkdown content={page.content} />
                        </Box>
                    </TabPanel>
                </SwipeableViews>
            </Paper>
        </Grid>
    );
}
