import * as React from 'react';
import { Grid, Divider, AppBar } from '@mui/material';
import BottomNavigation from '@mui/material/BottomNavigation';
import BottomNavigationAction from '@mui/material/BottomNavigationAction';
import { Send, Expand, Input } from '@mui/icons-material';
// import FavoriteIcon from '@mui/icons-material/Favorite';
// import LocationOnIcon from '@mui/icons-material/LocationOn';

import { useNavigate, useLocation } from "react-router-dom";
import { useGlobalState } from "../db/db";


export default function BottomNav() {
    const location = useLocation()
    const [path, setPath] = useGlobalState('pathname')

    const navigate = useNavigate()

    return (
        <Grid item xs={12}>
            <AppBar
                // position="absolute"
                position="fixed"
                color="primary"
                style={{ top: "auto", bottom: 0 }}
            >

                <BottomNavigation
                    // style={{
                    //     width: '100%',
                    //     position: 'fixed',
                    //     bottom: 10,
                    // }}
                    showLabels
                    value={path}
                    onChange={(event, newValue) => {
                        // setValue(newValue)
                        setPath(newValue)
                        navigate(newValue)
                    }}
                >
                    {/* <Divider /> */}
                    <BottomNavigationAction
                        label="Receive"
                        icon={<Input />}
                        value="/receive"
                    />
                    <BottomNavigationAction
                        label="Transactions"
                        icon={<Expand />}
                        value="/transactions"
                    />
                    <BottomNavigationAction
                        label="Send"
                        icon={<Send />}
                        value="/send"
                    />
                </BottomNavigation>
            </AppBar>
        </Grid>
    );
}