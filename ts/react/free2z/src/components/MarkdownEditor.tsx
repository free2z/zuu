import { useEffect, useState } from "react"

import SwipeableViews from "react-swipeable-views"
import { useTheme } from "@mui/material/styles"
import Tabs from "@mui/material/Tabs"
import Tab from "@mui/material/Tab"
import Box from "@mui/material/Box"
import { PageInterface } from "./PageRenderer"
import MathMarkdown from "./MathMarkdown"
import { Divider, Grid, IconButton, Paper, Stack, Tooltip } from "@mui/material"

import { Fullscreen, FullscreenExit, HelpCenter } from "@mui/icons-material"
import { AxiosResponse } from "axios"
import F2ZMarkdownField from "./F2ZMarkdownField"
import { TabPanel } from "./TabPanel"


export const noCommands = [
    "comment",
    "strikethrough",
    "checked-list",
    // need fewer because too many on mobile
    "edit",
    "live",
    "preview",
    // would be a cool one to work
    "fullscreen",
]

interface MarkdownEditorProps {
    page: PageInterface
    setPage: React.Dispatch<React.SetStateAction<PageInterface>>
    handleSave: () => Promise<AxiosResponse<any, any>>
}


export default function MarkdownEditor(props: MarkdownEditorProps) {
    const { page, setPage, handleSave } = props
    const theme = useTheme()
    const [value, setValue] = useState(0)
    const [isFullScreen, setIsFullScreen] = useState(false);


    useEffect(() => {
        // Change overflow on full-screen toggle
        document.body.style.overflow = isFullScreen ? 'hidden' : 'auto';

        // Cleanup on unmount
        return () => {
            document.body.style.overflow = 'auto';
        };
    }, [isFullScreen]);


    const handleFullScreenToggle = () => {
        const nextIsFullScreen = !isFullScreen;
        setIsFullScreen(nextIsFullScreen);
    };


    const handleChange = (event: React.SyntheticEvent, newValue: number) => {
        setValue(newValue)
    }

    const handleChangeIndex = (index: number) => {
        setValue(index)
    }

    return (
        <Grid
            item xs={12}
            style={isFullScreen ? {
                position: "fixed",
                top: 0,
                left: 0,
                bottom: 0,
                right: 0,
                // zIndex: 9999,
                // TODO: fragile
                // one less than dialog hrmmm
                zIndex: 1299,
                background: "white",
                height: "100vh",
                width: "100%",
                overflow: "auto"
            } : {}}
        >
            <Paper
                elevation={2}
            >
                <Box
                    component="div"
                    sx={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                    }}
                >
                    <Tabs
                        value={value}
                        onChange={handleChange}
                        indicatorColor="secondary"
                        textColor="inherit"
                    >
                        <Tab
                            // icon={<Edit />}
                            label="Edit"
                            onClick={handleSave}
                        />
                        <Tab
                            // icon={<Visibility />}
                            label="Preview"
                            onClick={handleSave}
                        />
                    </Tabs>
                    <Stack direction="row" spacing={1}
                        style={{
                            marginRight: "0.5em",
                        }}
                    >
                        <Tooltip title="Learn Free2Z-Flavored Markdown">
                            <IconButton
                                // size="large"
                                onClick={() => {
                                    const win = window.open(
                                        "https://free2z.cash/flavored-markdown",
                                        '_blank'
                                    )
                                    win?.focus()
                                }}
                            >
                                <HelpCenter />
                            </IconButton>
                        </Tooltip>
                        <Tooltip title="Toggle Fullscreen">
                            <IconButton onClick={handleFullScreenToggle}>
                                {isFullScreen ? <FullscreenExit /> : <Fullscreen />}
                            </IconButton>
                        </Tooltip>
                    </Stack>
                </Box>

                {/* </AppBar> */}
                <SwipeableViews
                    axis={theme.direction === "rtl" ? "x-reverse" : "x"}
                    index={value}
                    onChangeIndex={handleChangeIndex}
                    style={{
                        minHeight: "555px",
                        width: "100%",
                    }}
                >
                    <TabPanel
                        value={value}
                        index={0}
                    >
                        <F2ZMarkdownField
                            content={page.content}
                            cb={(v) => {
                                setPage({
                                    ...page,
                                    content: v || "",
                                })
                            }}
                            required={true}
                            title={page.title}
                            height={isFullScreen ? "calc(100vh - 54px)" : "555px"}
                        // height={isFullScreen ? "100vh" : "555px"}
                        />
                    </TabPanel>
                    <TabPanel
                        value={value}
                        index={1}
                    >
                        <Box component="div"
                            style={{
                                minHeight: "555",
                                textAlign: "left",
                                padding: "0 1em 1em 1em",
                            }}
                        >
                            <Divider />
                            <MathMarkdown content={props.page.content} />
                        </Box>
                    </TabPanel>
                </SwipeableViews>
            </Paper>
        </Grid>
    )
}
