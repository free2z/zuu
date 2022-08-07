import * as React from 'react';

import {
    AppBar, Typography, Toolbar, Tooltip, LinearProgress, Box, Badge
} from '@mui/material';

import AccountMenu from "./AccountMenu"
import { z } from '../db/db';
import WarpIcon from './WarpIcon';

const TROUBLES = 1730000

export default function TopBar() {
    const [syncHeight, setSyncHeight] = React.useState(0)
    const [serverHeight, setServerHeight] = React.useState(0)
    const [progress, setProgress] = React.useState(0)
    const [showProgress, setShowProgress] = React.useState(true)

    async function updateServer() {
        setServerHeight(await z.getServerHeight())
        setTimeout(updateServer, 30000)
    }
    async function updateSync() {
        setSyncHeight(await z.getSyncHeight())
        setTimeout(updateSync, 30000)
    }

    React.useEffect(() => {
        updateServer()
        updateSync()
    }, [])

    React.useEffect(() => {
        console.log(`${syncHeight} / ${serverHeight}`)
        // const progress = (
        //     (syncHeight - TROUBLES)
        //     /
        //     (serverHeight - TROUBLES)
        // ) * 100.0
        // console.log("PROGRESS", progress)
        setProgress(progress)
        setShowProgress(true)
        if (syncHeight >= serverHeight) {
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
                    <Box style={{ minWidth: "50px" }}>
                        <WarpIcon
                            syncHeight={syncHeight}
                            serverHeight={serverHeight}
                        />
                        {/* <Typography
                            color="orange"
                        >{`...${serverHeight - syncHeight}`}</Typography> */}
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
