import React from "react";
import { Chip, Divider, Tooltip } from "@mui/material";
import LoopIcon from "@mui/icons-material/Loop";

export interface WarpIconInterface {
    syncHeight: number,
    serverHeight: number,
}

export default function WarpIcon(props: WarpIconInterface) {
    const { syncHeight, serverHeight } = props

    return (
        <Divider>
            <style>{`
            @keyframes spin {
                 0% { transform: rotate(360deg); }
                 100% { transform: rotate(0deg); }
            }`}
            </style>
            <Tooltip title={`${syncHeight}/${serverHeight}`}>
                <Chip
                    // label={`${syncHeight}/${serverHeight}`}
                    label={`..${serverHeight - syncHeight}`}
                    icon={<LoopIcon
                        fontSize="medium"
                        // color="warning"
                        style={{
                            animation: "spin 10s linear infinite"
                        }}
                    />}
                    color="warning"
                    variant="outlined"
                />
            </Tooltip>
        </Divider>
    )

}
