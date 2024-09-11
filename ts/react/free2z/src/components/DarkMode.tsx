import React from "react"

import { Brightness7, Brightness3 } from "@mui/icons-material"
import { dispatch, useStoreState } from "../state/persist"
import { Box, IconButton, Tooltip } from "@mui/material"

export default function DarkMode() {
    const darkMode = useStoreState("darkmode")

    let Icon;
    if (!darkMode) {
        Icon = <Brightness3
            color="warning"
        />
    } else {
        Icon = <Brightness7
            color="warning"
        />
    }
    return (
        <Box component="div" display="flex" alignItems="center">
            <Tooltip title="Toggle dark mode">
                <IconButton
                    onClick={() => {
                        dispatch({
                            type: "setDarkmode",
                            darkmode: !darkMode,
                        })
                    }}
                >
                    {Icon}
                </IconButton>
            </Tooltip>
        </Box>
    )
}