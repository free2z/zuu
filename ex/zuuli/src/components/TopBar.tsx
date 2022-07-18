import * as React from 'react';

import { Grid, Divider, AppBar, Typography, Toolbar } from '@mui/material';
import BottomNavigation from '@mui/material/BottomNavigation';
import BottomNavigationAction from '@mui/material/BottomNavigationAction';
import { Send, Expand, Input } from '@mui/icons-material';

import { useNavigate, useLocation } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks"

import AccountSpeedDial from "./AccountSpeedDial"
import AccountMenu from "./AccountMenu"


export default function TopBar() {

    return (
        <AppBar
            position="static"
            variant='elevation'
            color="transparent"
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
                {/* <Typography variant="h3">ZUULI</Typography> */}
                {/* <AccountSpeedDial /> */}
                <AccountMenu />
            </Toolbar>
        </AppBar>
    );
}
