
import moment from "moment"

import { Avatar, Link, Stack, Tooltip, Typography } from "@mui/material"

import { RocketLaunch, Psychology } from "@mui/icons-material"

import { formatDate, PageInterface } from "./PageRenderer"

export default function PageDateTimes(props: PageInterface) {

    return (
        <Stack
            direction="row"
            spacing={2}
            style={{
                // margin: "0 auto",
                // width: "150px",
            }}
        >
            <Tooltip title={`Created on ${formatDate(props.created_at)}`}>
                <Stack direction="row">
                    <RocketLaunch
                        color="primary"
                        fontSize="small"
                        style={{ marginRight: "0.1em" }}
                    />
                    <Typography variant="caption">
                        {moment(props.created_at).fromNow()}
                    </Typography>
                </Stack>
            </Tooltip>
            <Tooltip title={`Updated on ${formatDate(props.updated_at)}`}>
                <Stack direction="row">
                    <Psychology
                        color="info"
                        fontSize="small"
                        style={{ marginRight: "0.1em" }}
                    />
                    <Typography variant="caption">
                        {moment(props.updated_at).fromNow()}
                    </Typography>
                </Stack>
            </Tooltip>
        </Stack>
    )
}
