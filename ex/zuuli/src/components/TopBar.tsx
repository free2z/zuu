import * as React from 'react';

import { Grid, Divider, AppBar, Typography, Toolbar, Tooltip, LinearProgress, Box } from '@mui/material';
import BottomNavigation from '@mui/material/BottomNavigation';
import BottomNavigationAction from '@mui/material/BottomNavigationAction';
import { Send, Expand, Input } from '@mui/icons-material';

import { useNavigate, useLocation } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks"

import AccountSpeedDial from "./AccountSpeedDial"
import AccountMenu from "./AccountMenu"

import { useGlobalState, z } from "../db/db"

const TROUBLES = 1730000

export default function TopBar() {
    const [syncHeight, setSyncHeight] = React.useState(0)
    const [serverHeight, setServerHeight] = React.useState(0)
    const [progress, setProgress] = React.useState(0)
    const [showProgress, setShowProgress] = React.useState(true)
    const [pColor, setpColor] = React.useState("primary" as "primary" | "secondary" | "error" | "info" | "success" | "warning")

    async function updateServer() {
        setServerHeight(await z.getServerHeight())
        setTimeout(updateServer, 90000)
    }
    async function updateSync() {
        setSyncHeight(await z.getSyncHeight())
        setTimeout(updateSync, 15000)
    }

    React.useEffect(() => {
        updateServer()
        updateSync()
    }, [])

    React.useEffect(() => {
        const progress = (
            (syncHeight - TROUBLES)
            /
            (serverHeight - TROUBLES)
        ) * 100.0
        console.log("PROGRESS", progress)
        setProgress(progress)
        setShowProgress(true)
        if (progress < 5) {
            setpColor("error")
        } else if (progress < 20) {
            setpColor("warning")
        } else if (progress < 30) {
            setpColor("secondary")
        } else if (progress < 50) {
            setpColor("info")
        } else if (progress < 100) {
            setpColor("primary")
        } else if (syncHeight >= serverHeight) {
            setShowProgress(false)
        }
    }, [syncHeight, serverHeight])

    return (
        <AppBar
            // position="static"
            // position='absolute'
            position="fixed"
            variant='elevation'
            // color="transparent"
            color="inherit"
        >
            <Toolbar>
                <Typography
                    variant="h6"
                    component="div"
                    sx={{ flexGrow: 1 }}
                    color="secondary"
                >
                    ZUULI
                </Typography>

                {showProgress &&
                    <Box style={{ minWidth: "100px" }}>
                        <Tooltip title={`${syncHeight}/${serverHeight}`}>
                            <LinearProgress
                                color={pColor}
                                variant='determinate'
                                value={progress}
                            />
                        </Tooltip>
                    </Box>
                }
                {!showProgress &&
                    <Typography
                        color="green"
                        variant='subtitle2'
                    >
                        {syncHeight}
                    </Typography>
                }
                <AccountMenu />
            </Toolbar>
        </AppBar >
    );
}
